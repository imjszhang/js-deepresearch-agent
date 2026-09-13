/** The interpretation of a recorded model response is part of its protocol identity. */
export const STRUCTURED_RESPONSE_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  maxInputChars: 2_000_000,
  maxCandidates: 32,
  maxDepth: 128,
  maxScanChars: 4_000_000,
});
const REASONS = new Set([
  'empty', 'truncated', 'no_complete_json', 'invalid_json',
  'ambiguous_result', 'schema_invalid', 'resource_limit',
]);
const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);

class ParseFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function spend(context, amount = 1) {
  context.scanned += amount;
  if (context.scanned > context.limits.maxScanChars) throw new ParseFailure('resource_limit');
}

// Validate JSON before JSON.parse, which otherwise silently overwrites duplicate keys.
// Canonicalization changes object key ordering only: arrays and numeric lexemes remain intact.
function strictJson(text, context) {
  let at = 0;
  const space = () => {
    while (at < text.length && /[\t\n\r ]/.test(text[at])) { at += 1; spend(context); }
  };
  const expected = (character) => {
    if (at >= text.length) throw new ParseFailure('no_complete_json');
    if (text[at++] !== character) throw new ParseFailure('invalid_json');
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      spend(context);
      const character = text[at++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, at)); }
        catch { throw new ParseFailure('invalid_json'); }
      }
      if (character === '\\') { at += 1; spend(context); }
    }
    throw new ParseFailure('no_complete_json');
  };
  const value = (depth) => {
    space();
    spend(context);
    const character = text[at];
    if ((character === '{' || character === '[') && depth >= context.limits.maxDepth) throw new ParseFailure('resource_limit');
    if (character === '"') return JSON.stringify(string());
    if (character === '{') {
      at += 1;
      space();
      const entries = [];
      const keys = new Set();
      if (text[at] === '}') { at += 1; return '{}'; }
      while (at < text.length) {
        if (text[at] !== '"') throw new ParseFailure('invalid_json');
        const key = string();
        if (keys.has(key)) throw new ParseFailure('invalid_json');
        keys.add(key);
        space();
        expected(':');
        const child = value(depth + 1);
        entries.push([key, child]);
        space();
        if (text[at] === '}') {
          at += 1;
          entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
          return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${child}`).join(',')}}`;
        }
        expected(',');
        space();
      }
      throw new ParseFailure('no_complete_json');
    }
    if (character === '[') {
      at += 1;
      space();
      const items = [];
      if (text[at] === ']') { at += 1; return '[]'; }
      while (at < text.length) {
        items.push(value(depth + 1));
        space();
        if (text[at] === ']') { at += 1; return `[${items.join(',')}]`; }
        expected(',');
        space();
      }
      throw new ParseFailure('no_complete_json');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) throw new ParseFailure(at >= text.length ? 'no_complete_json' : 'invalid_json');
    at += token[0].length;
    spend(context, token[0].length);
    return token[0];
  };
  const canonical = value(0);
  space();
  if (at !== text.length) throw new ParseFailure('invalid_json');
  try { return { parsed: JSON.parse(text), canonical }; }
  catch { throw new ParseFailure('invalid_json'); }
}

function rootMatches(value, rootType) {
  if (rootType === 'array') return Array.isArray(value);
  if (rootType === 'any') return value !== null && typeof value === 'object';
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reasoningTag(text, at) {
  if (text[at] !== '<') return null;
  return /^<(\/?)\s*(think|analysis)\b[^<>]*>/i.exec(text.slice(at));
}

function fenceAt(text, at, context) {
  if (text[at] !== '`' && text[at] !== '~') return null;
  const marker = text[at];
  let markerEnd = at;
  while (text[markerEnd] === marker) markerEnd += 1;
  if (markerEnd - at < 3) return null;
  let lineEnd = markerEnd;
  while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd += 1;
  spend(context, lineEnd - at);
  // Return even an unfinished opening line so its suffix is never rescanned per marker.
  return {
    marker,
    markerLength: markerEnd - at,
    info: text.slice(markerEnd, lineEnd).trim(),
    bodyStart: lineEnd < text.length ? lineEnd + 1 : null,
  };
}

function closingFence(text, start, opening, context) {
  for (let at = start; at < text.length;) {
    const newline = text.indexOf('\n', at);
    const end = newline < 0 ? text.length : newline;
    spend(context, end - at + 1);
    let cursor = at;
    while (cursor < end && /[\t ]/.test(text[cursor])) cursor += 1;
    const markerStart = cursor;
    while (text[cursor] === opening.marker) cursor += 1;
    const count = cursor - markerStart;
    while (cursor < end && /[\t\r ]/.test(text[cursor])) cursor += 1;
    if (count >= opening.markerLength && cursor === end) return { start: at, end: newline < 0 ? end : end + 1 };
    at = end + 1;
  }
  return null;
}

function looksLikeJson(text, at) {
  const tail = text.slice(at + 1).trimStart();
  return text[at] === '{' ? /^["}]/.test(tail) : /^(?:["[\]{}\d-]|true\b|false\b|null\b)/.test(tail);
}

function collectCandidates(text, context, { ignoreStandaloneCitationTokens = false } = {}) {
  const candidates = [];
  let invalid = 0;
  let incomplete = 0;
  let excluded = 0;
  const add = (start, end, source, forced = true) => {
    if (candidates.length + invalid + incomplete >= context.limits.maxCandidates) throw new ParseFailure('resource_limit');
    try {
      const candidate = strictJson(text.slice(start, end).trim(), context);
      candidates.push({ ...candidate, start, end, source });
    } catch (error) {
      if (error.reason === 'resource_limit') throw error;
      if (forced) {
        if (error.reason === 'no_complete_json') incomplete += 1;
        else invalid += 1;
      }
    }
  };

  for (let at = 0; at < text.length;) {
    spend(context);
    const tag = reasoningTag(text, at);
    if (tag) {
      at += tag[0].length;
      if (tag[1]) continue; // A provider may omit the leading reasoning opener.
      excluded += 1;
      const tags = [tag[2].toLowerCase()];
      while (at < text.length && tags.length) {
        spend(context);
        const nested = reasoningTag(text, at);
        if (!nested) { at += 1; continue; }
        const name = nested[2].toLowerCase();
        if (!nested[1]) tags.push(name);
        else if (tags.at(-1) === name) tags.pop();
        at += nested[0].length;
      }
      continue;
    }
    const fence = fenceAt(text, at, context);
    if (fence) {
      const end = fence.bodyStart === null ? null : closingFence(text, fence.bodyStart, fence, context);
      const jsonFence = /^(?:json|application\/json)?\s*$/i.test(fence.info);
      if (!end) {
        if (jsonFence) incomplete += 1;
        else excluded += 1;
        break;
      }
      if (jsonFence) add(fence.bodyStart, end.start, 'fence');
      else excluded += 1;
      at = end.end;
      continue;
    }
    if (text[at] === '"') {
      // A JSON string is not an answer container; do not promote its contents.
      let end = at + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') {
        spend(context);
        end += text[end] === '\\' ? 2 : 1;
      }
      if (text[end] === '"') { at = end + 1; continue; }
    }
    if (text[at] !== '{' && text[at] !== '[') { at += 1; continue; }
    const start = at;
    const plausible = looksLikeJson(text, start);
    const stack = [text[at++]];
    let quoted = false;
    while (at < text.length && stack.length) {
      spend(context);
      const character = text[at];
      if (quoted) {
        if (character === '\\') { at += 2; spend(context); continue; }
        if (character === '"') quoted = false;
        at += 1;
        continue;
      }
      // Prose braces must not swallow a subsequent explicit answer fence.
      if (fenceAt(text, at, context) || reasoningTag(text, at)) break;
      at += 1;
      if (character === '"') { quoted = true; continue; }
      if (character === '{' || character === '[') {
        stack.push(character);
        if (stack.length > context.limits.maxDepth) throw new ParseFailure('resource_limit');
      }
      if (character === '}' || character === ']') {
        const opener = stack.pop();
        if ((opener === '{') !== (character === '}')) break;
      }
    }
    // Legacy narrative callers may accept Markdown alongside JSON. This is a caller
    // policy for standalone citation tokens only, never a rewrite of JSON or fences.
    if (ignoreStandaloneCitationTokens && text[start] === '['
      && /^\[\d+(?:\.\d+)?(?:\s*[-,，]\s*\d+(?:\.\d+)?)*\]$/.test(text.slice(start, at))) {
      excluded += 1;
    } else if (plausible) add(start, at, 'standalone');
  }
  return { candidates, invalid, incomplete, excluded };
}

/**
 * Select one unambiguous, complete JSON answer without repairing it or weakening its schema.
 * Only a unique schema-invalid candidate is returned for callers' semantic diagnostics.
 * All diagnostics are counts, booleans or fixed protocol enums; they never contain model text.
 */
export function parseStructuredResponse(text = '', options = {}) {
  const raw = String(text ?? '').trim();
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [key, options[key] ?? fallback]));
  const context = { limits, scanned: 0 };
  const diagnostics = {
    protocolVersion: STRUCTURED_RESPONSE_VERSION,
    inputChars: raw.length,
    candidateCount: 0,
    distinctCandidateCount: 0,
    invalidCandidateCount: 0,
    incompleteCandidateCount: 0,
    excludedRegionCount: 0,
  };
  const result = (ok, reason, parsed = null) => ({ ok, parsed, reason, diagnostics: { ...diagnostics, scannedChars: context.scanned } });
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) || limits.maxDepth > 256 || raw.length > limits.maxInputChars) return result(false, 'resource_limit');
  const metadata = options.metadata;
  const finishReason = metadata?.finishReason ?? metadata?.finish_reason ?? metadata?.stopReason ?? metadata?.stop_reason;
  if (TRUNCATED.has(String(finishReason || '').toLowerCase())) return result(false, 'truncated');
  if (!raw) return result(false, 'empty');
  const rootType = options.rootType ?? 'object';
  const accept = options.accept ?? (() => true);
  const select = (candidate) => {
    let accepted = false;
    try { accepted = rootMatches(candidate.parsed, rootType) && Boolean(accept(candidate.parsed)); }
    catch { /* Validators describe schema acceptance; their exception is not model text. */ }
    return accepted ? result(true, null, candidate.parsed) : result(false, 'schema_invalid', candidate.parsed);
  };
  try {
    // A strict complete response is authoritative, including literal reasoning tags in strings.
    try {
      const whole = strictJson(raw, context);
      diagnostics.candidateCount = 1;
      diagnostics.distinctCandidateCount = 1;
      return select(whole);
    } catch (error) {
      if (error.reason === 'resource_limit') throw error;
    }
    const { candidates, invalid, incomplete, excluded } = collectCandidates(raw, context, {
      ignoreStandaloneCitationTokens: options.ignoreStandaloneCitationTokens === true && rootType === 'object',
    });
    const distinct = new Map(candidates.map((candidate) => [candidate.canonical, candidate]));
    diagnostics.candidateCount = candidates.length;
    diagnostics.distinctCandidateCount = distinct.size;
    diagnostics.invalidCandidateCount = invalid;
    diagnostics.incompleteCandidateCount = incomplete;
    diagnostics.excludedRegionCount = excluded;
    if (distinct.size > 1 || (distinct.size && (invalid || incomplete))) return result(false, 'ambiguous_result');
    if (incomplete) return result(false, 'no_complete_json');
    if (invalid) return result(false, 'invalid_json');
    if (!distinct.size) return result(false, 'no_complete_json');
    return select(distinct.values().next().value);
  } catch (error) {
    if (error instanceof ParseFailure) return result(false, error.reason);
    throw error;
  }
}

export function extractJsonObject(text = '') {
  const result = parseStructuredResponse(text);
  return result.ok ? result.parsed : null;
}

export function buildStructuredRetryMessages(messages = [], reason = 'invalid_json') {
  const category = REASONS.has(reason) ? reason : 'invalid_json';
  return [...messages, {
    role: 'user',
    content: `The previous response failed structural validation (${category}). Return exactly one complete JSON value matching the requested schema. Preserve every required identifier exactly once. Do not include explanations, examples, reasoning, or alternative answers.`,
  }];
}
