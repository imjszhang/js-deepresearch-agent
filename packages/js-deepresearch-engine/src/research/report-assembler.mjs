import { classifyClaimSection } from './claim-quality.mjs';
import { getSourceEvidenceClass } from './focused-settings.mjs';
import { DEFAULT_MAX_PASSAGE_CHARS, selectDisplayedEvidence } from './evidence-chain.mjs';

function splitMarkdownSections(markdown) {
  const parts = [];
  let current = { heading: '', level: 0, lines: [] };
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (current.heading || current.lines.length) parts.push(current);
      current = { heading: match[2].trim(), level: match[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading || current.lines.length) parts.push(current);
  return parts;
}

function formatSection(part) {
  if (!part.heading) return part.lines.join('\n').trim();
  return `${'#'.repeat(Math.max(1, part.level))} ${part.heading}\n${part.lines.join('\n')}`.trim();
}

export const SOURCE_DUMP_LINE = /\[[0-9]+(?:\.[0-9]+)?\][^\n]*\((?:source body|snippet only|source summary)\)\s*:/i;

export function containsSourceDump(text = '') {
  return SOURCE_DUMP_LINE.test(String(text));
}

function normalizeComparable(value = '') {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function looksLikeDumpSection(part = {}, query = '') {
  const heading = normalizeComparable(part.heading || '');
  const body = Array.isArray(part.lines) ? part.lines.join('\n') : String(part.body || '');
  if (containsSourceDump(body)) return true;
  const normalizedQuery = normalizeComparable(query);
  if (normalizedQuery && heading && heading === normalizedQuery) return true;
  return heading.length > 80 && containsSourceDump(body);
}

function isGeneratedHeading(heading) {
  const kind = classifyClaimSection(heading);
  return kind === 'source_entry' || kind === 'evidence_entry';
}

function isCaveatHeading(heading) {
  return classifyClaimSection(heading) === 'caveat';
}

export function keepNarrativeSections(narrative, { query = '' } = {}) {
  const kept = [];
  for (const part of splitMarkdownSections(narrative)) {
    if (!part.heading) {
      if (part.lines.some((line) => line.trim()) && !containsSourceDump(part.lines.join('\n'))) {
        kept.push(formatSection(part));
      }
      continue;
    }
    const generated = isGeneratedHeading(part.heading) || isCaveatHeading(part.heading);
    if (generated && part.level <= 2) break;
    if (generated) continue;
    if (looksLikeDumpSection(part, query)) continue;
    if (part.level === 1 || !isGeneratedHeading(part.heading)) {
      kept.push(formatSection(part));
    }
  }
  return kept.join('\n\n').trim();
}

function extractNarrativeCaveats(narrative) {
  return splitMarkdownSections(narrative)
    .filter((part) => isCaveatHeading(part.heading))
    .flatMap((part) => part.lines.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean));
}

function citationKey(findingIndex, sourceIndex) {
  return `${findingIndex + 1}.${sourceIndex + 1}`;
}

export function renderEvidenceSection(findings = [], {
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const blocks = findings.map((finding, findingIndex) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    const items = sources.map((source, sourceIndex) => {
      const key = citationKey(findingIndex, sourceIndex);
      const klass = getSourceEvidenceClass(source);
      const text = selectDisplayedEvidence(source, { passages, maxChars: maxPassageChars }) || 'No extracted evidence.';
      const title = source.title || source.url || key;
      return `*   **[${key}] ${title}** (${klass.replaceAll('_', ' ')}): ${text}`;
    });
    const question = finding.question || `Finding ${findingIndex + 1}`;
    return `### ${question}\n\n${items.join('\n') || '*   No sources.'}`;
  });
  return `## Evidence\n\n${blocks.join('\n\n') || 'No collected evidence.'}`;
}

export function renderSourcesSection(findings = []) {
  const lines = [];
  findings.forEach((finding, findingIndex) => {
    (finding.sources || []).forEach((source, sourceIndex) => {
      const provenance = [
        source.publisher && `publisher: ${source.publisher}`,
        source.author && `author: ${source.author}`,
        source.publishedAt && `published: ${source.publishedAt}`,
        source.updatedAt && `updated: ${source.updatedAt}`,
        source.accessedAt && `accessed: ${source.accessedAt}`,
        source.sourceType && `type: ${source.sourceType}`,
        source.jurisdiction && `jurisdiction: ${source.jurisdiction}`,
        source.productVersion && `version: ${source.productVersion}`,
        source.accessStatus && `access: ${source.accessStatus}`,
      ].filter(Boolean);
      lines.push(`- [${citationKey(findingIndex, sourceIndex)}] ${source.title || 'Untitled'} | ${source.url || ''}${provenance.length ? ` | ${provenance.join('; ')}` : ''}`);
    });
  });
  return `## Sources\n\n${lines.join('\n') || '- No sources.'}`;
}

const INSUFFICIENT_EVIDENCE_PREFIX = /^(?:insufficient direct evidence for:\s*)/i;

export function normalizeCaveatKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(INSUFFICIENT_EVIDENCE_PREFIX, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.!?！？]+$/g, '')
    .toLowerCase();
}

export function renderCaveatsSection(limitations = [], narrativeCaveats = []) {
  const seen = new Set();
  const items = [];
  for (const item of [...limitations, ...narrativeCaveats]) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = normalizeCaveatKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  const body = items.length
    ? items.map((item) => `- ${item}`).join('\n')
    : '- No additional caveats were recorded.';
  return `## Caveats\n\n${body}`;
}

export function assembleReport({
  narrative = '',
  findings = [],
  limitations = [],
  query = '',
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const kept = keepNarrativeSections(narrative, { query }) || `# Research Report\n\n${query}`.trim();
  const caveats = renderCaveatsSection(limitations, extractNarrativeCaveats(narrative));
  return [
    kept,
    renderEvidenceSection(findings, { passages, maxPassageChars }),
    caveats,
    renderSourcesSection(findings),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

const LIST_PREFIX = /^\s*(?:[-*]|\d+[.)])\s+/;
const WEAK_CLAIM_FLAGS = new Set(['uncited', 'snippet_only', 'unresolved_citation', 'missing_direct_evidence']);

function claimHasSourceContent(claim = {}) {
  return (claim.evidence || []).some((item) => {
    if (!item?.passageId) return false;
    const origin = String(item.origin || item.evidenceOrigin || '').toLowerCase();
    return origin !== 'search_snippet' && origin !== 'snippet';
  });
}

export function shouldMoveWeakKeyClaim(claim = {}) {
  if (claim.kind !== 'key_claim') return false;
  const verdict = claim.evaluation?.verdict;
  if (verdict === 'unsupported') return true;
  if (verdict !== 'unverifiable') return false;
  if (claimHasSourceContent(claim)) return false;
  const flags = claim.evaluation?.flags || claim.flags || [];
  if (flags.some((flag) => WEAK_CLAIM_FLAGS.has(flag))) return true;
  return !claim.citedSourceId
    && !(claim.citedSourceIds || []).length
    && !(claim.evidence || []).length;
}

function claimLineMatches(line, text) {
  const stripped = String(line || '').replace(LIST_PREFIX, '').trim();
  if (!stripped) return false;
  if (stripped === text) return true;
  if (!stripped.startsWith(text)) return false;
  const next = stripped[text.length];
  return !next || next === '[' || /[\s.。，,;；]/.test(next);
}

function isListLine(line) {
  return LIST_PREFIX.test(String(line || ''));
}

function removeClaimLines(narrative, text) {
  const lines = String(narrative || '').split('\n');
  const kept = [];
  let removed = false;
  for (const line of lines) {
    if (isListLine(line) && claimLineMatches(line, text)) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  const next = kept.join('\n').replace(/(\n[ \t]*){3,}/g, '\n\n');
  return { text: next, removed };
}

export function reviseUnsupportedKeyClaims(report, claims = []) {
  const weak = claims.filter(shouldMoveWeakKeyClaim);
  let next = String(report || '');
  const moved = [];
  for (const claim of weak) {
    const text = String(claim.text || '').trim();
    if (!text) continue;
    const result = removeClaimLines(next, text);
    if (!result.removed) continue;
    next = result.text;
    moved.push(text);
  }
  return { report: next.trim(), moved };
}
