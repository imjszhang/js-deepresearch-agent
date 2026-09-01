import { isSuccessfulBody } from './body-quality.mjs';
import { passageContainsQuote } from './claim-entailment.mjs';
import { isRequiredSlot, needsSemanticClose } from './gap-state.mjs';
import { splitContentForPassages, tokenOverlapScore } from './passage-utils.mjs';
import { gapSlotSupportPrompt } from './prompts.mjs';
import { completeStructuredJson } from './structured-llm.mjs';

export const SLOT_SUPPORT_VERDICTS = Object.freeze([
  'supported',
  'partially_supported',
  'unsupported',
  'unverifiable',
  'conflicting',
]);

const VERDICTS = new Set(SLOT_SUPPORT_VERDICTS);
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_CHUNK_CHARS = 2400;

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function sourceIdentity(source) {
  return source?.id || source?.url || null;
}

export function collectSuccessfulPassages(findings = [], { gapId = null, allowFallback = true } = {}) {
  const dedicatedFindings = findings.filter((finding) => !gapId || finding.gapId === gapId);
  const toPassages = (items) => items.flatMap((finding) => (
    (finding.sources || []).filter(isSuccessfulBody).map((source) => {
      const text = String(source.content || source.summary || '').trim();
      if (!text) return null;
      return {
        id: (source.passageIds && source.passageIds[0]) || `body:${sourceIdentity(source)}`,
        sourceId: sourceIdentity(source),
        text,
        gapId: finding.gapId || null,
      };
    }).filter(Boolean)
  ));
  const dedicated = toPassages(dedicatedFindings);
  if (dedicatedFindings.length && gapId) return dedicated;
  if (!allowFallback) return dedicated;
  return dedicated.length ? dedicated : toPassages(findings);
}

export function selectSlotPassages(gap, findings = [], {
  topK = 3,
  chunkChars = DEFAULT_CHUNK_CHARS,
} = {}) {
  const focus = [gap.question, gap.answerSlot, ...(gap.evidenceCriteria || [])].filter(Boolean).join(' ');
  return collectSuccessfulPassages(findings, { gapId: gap.id, allowFallback: true })
    .flatMap((passage) => {
      const chunks = splitContentForPassages(passage.text, chunkChars);
      const fallback = {
        text: passage.text.slice(0, chunkChars),
        startChar: 0,
        endChar: Math.min(passage.text.length, chunkChars),
      };
      return (chunks.length ? chunks : [fallback]).map((chunk) => ({
        ...passage,
        text: chunk.text,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        section: chunk.section,
        retrievalScore: tokenOverlapScore(focus, chunk.text),
      }));
    })
    .sort((left, right) => (right.retrievalScore || 0) - (left.retrievalScore || 0))
    .slice(0, topK);
}

export function slotsNeedingSupport(gaps = []) {
  return gaps.filter((gap) => {
    if (gap?.rollup) return false;
    if (!needsSemanticClose(gap) && !isRequiredSlot(gap)) return false;
    if (gap.status === 'verified' && gap.slotSupport?.verdict === 'supported' && gap.slotSupport?.quoteAnchored) {
      return false;
    }
    return true;
  });
}

export function failClosedSupport(reason = 'invalid_or_empty_json') {
  return {
    verdict: 'unverifiable',
    quote: '',
    supportingPassageIds: [],
    contradictingPassageIds: [],
    reason,
    method: 'fail_closed',
    quoteAnchored: false,
  };
}

function normalizeJudgment(raw = {}, passages = []) {
  const verdict = String(raw.verdict || '').trim();
  const quote = String(raw.quote || '').trim();
  const passageIds = new Set(passages.map((passage) => passage.id));
  const supportingPassageIds = unique(raw.supportingPassageIds).filter((id) => passageIds.has(id));
  const contradictingPassageIds = unique(raw.contradictingPassageIds).filter((id) => passageIds.has(id));
  if (!VERDICTS.has(verdict)) return failClosedSupport('invalid_verdict');
  if (!passageContainsQuote(passages, quote)) return failClosedSupport('quote_not_in_body');
  const quoted = passages.find((passage) => passageContainsQuote([passage], quote));
  return {
    gapId: raw.gapId || null,
    answerSlot: raw.answerSlot || null,
    question: raw.question || null,
    verdict,
    quote,
    supportingPassageIds: supportingPassageIds.length
      ? supportingPassageIds
      : (quoted?.id ? [quoted.id] : []),
    contradictingPassageIds,
    reason: String(raw.reason || '').trim() || null,
    method: 'llm',
    quoteAnchored: true,
  };
}

function hasUsableSupportPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.judgments) && parsed.judgments.length > 0) return true;
  return Boolean(parsed.verdict);
}

function judgmentsFromParsed(parsed) {
  if (Array.isArray(parsed?.judgments)) return parsed.judgments;
  if (parsed?.verdict) return [parsed];
  return [];
}

function matchJudgment(gap, judgments = []) {
  return judgments.find((item) => item.gapId && item.gapId === gap.id)
    || judgments.find((item) => item.answerSlot && item.answerSlot === gap.answerSlot)
    || judgments.find((item) => item.question && item.question === gap.question)
    || null;
}

export function applySlotSupportJudgments(gaps = [], judgments = []) {
  for (const gap of gaps) {
    const judgment = judgments.find((item) => item.gapId === gap.id)
      || judgments.find((item) => item.answerSlot && item.answerSlot === gap.answerSlot)
      || judgments.find((item) => item.question && item.question === gap.question);
    if (judgment) gap.slotSupport = judgment;
  }
  return gaps;
}

function failClosedTargets(targets, reason) {
  return targets.map(({ gap }) => ({
    ...failClosedSupport(reason),
    gapId: gap.id,
    answerSlot: gap.answerSlot || null,
    question: gap.question || null,
  }));
}

function hasCompleteBatchPayload(parsed, targets) {
  if (!hasUsableSupportPayload(parsed)) return false;
  const judgments = judgmentsFromParsed(parsed);
  if (targets.length === 1 && judgments.length === 1) return true;
  return targets.every(({ gap }) => Boolean(matchJudgment(gap, judgments)));
}

function normalizeBatchJudgments(targets, parsed) {
  const rawJudgments = judgmentsFromParsed(parsed);
  return targets.map(({ gap, passages }) => {
    const matched = matchJudgment(gap, rawJudgments)
      || (targets.length === 1 && rawJudgments.length === 1 ? rawJudgments[0] : null);
    if (!matched) {
      return {
        ...failClosedSupport('unmatched_judgment'),
        gapId: gap.id,
        answerSlot: gap.answerSlot,
        question: gap.question,
      };
    }
    return {
      ...normalizeJudgment({
        ...matched,
        gapId: gap.id,
        answerSlot: gap.answerSlot,
        question: gap.question,
      }, passages),
      gapId: gap.id,
      answerSlot: gap.answerSlot || matched.answerSlot || null,
      question: gap.question || matched.question || null,
    };
  });
}

async function judgeTargetBatch({ llm, signal, query, targets }) {
  const maxTokens = Math.max(800, targets.length * 600);
  try {
    const result = await completeStructuredJson({
      llm,
      signal,
      purpose: 'gap_support',
      maxTokens,
      retryMaxTokens: maxTokens + 400,
      accept: (parsed) => hasCompleteBatchPayload(parsed, targets),
      messages: gapSlotSupportPrompt({ query, slots: targets }),
      retryMessages: gapSlotSupportPrompt({ query, slots: targets, compact: true }),
    });
    if (result.ok) {
      const judgments = normalizeBatchJudgments(targets, result.parsed);
      return {
        judgments,
        unknown: judgments.some((item) => item.method === 'fail_closed'),
        retried: result.retried,
        attempts: result.attempts,
        splitRetries: 0,
      };
    }
    if (targets.length > 1) {
      const midpoint = Math.ceil(targets.length / 2);
      const left = await judgeTargetBatch({ llm, signal, query, targets: targets.slice(0, midpoint) });
      const right = await judgeTargetBatch({ llm, signal, query, targets: targets.slice(midpoint) });
      return {
        judgments: [...left.judgments, ...right.judgments],
        unknown: left.unknown || right.unknown,
        retried: true,
        attempts: result.attempts + left.attempts + right.attempts,
        splitRetries: 1 + left.splitRetries + right.splitRetries,
      };
    }
    return {
      judgments: failClosedTargets(targets, result.reason || 'invalid_or_empty_json'),
      unknown: true,
      retried: result.retried,
      attempts: result.attempts,
      splitRetries: 0,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    if (targets.length > 1) {
      const midpoint = Math.ceil(targets.length / 2);
      const left = await judgeTargetBatch({ llm, signal, query, targets: targets.slice(0, midpoint) });
      const right = await judgeTargetBatch({ llm, signal, query, targets: targets.slice(midpoint) });
      return {
        judgments: [...left.judgments, ...right.judgments],
        unknown: left.unknown || right.unknown,
        retried: true,
        attempts: left.attempts + right.attempts,
        splitRetries: 1 + left.splitRetries + right.splitRetries,
      };
    }
    return {
      judgments: failClosedTargets(targets, error?.message || 'judge_error'),
      unknown: true,
      retried: false,
      attempts: 1,
      splitRetries: 0,
    };
  }
}

export async function judgeOpenSlotSupport({
  llm,
  signal,
  query,
  gaps = [],
  findings = [],
  topK = 3,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const targets = [];
  for (const gap of slotsNeedingSupport(gaps)) {
    const passages = selectSlotPassages(gap, findings, { topK });
    if (!passages.length) continue;
    targets.push({ gap, passages });
  }
  if (!targets.length) {
    return { judgments: [], unknown: false, retried: false, attempts: 0, batches: 0, splitRetries: 0 };
  }

  if (!llm?.complete) {
    return {
      judgments: failClosedTargets(targets, 'no_llm'),
      unknown: true,
      retried: false,
      attempts: 0,
      batches: 0,
      splitRetries: 0,
    };
  }

  const requestedSize = Number(batchSize);
  const size = Number.isFinite(requestedSize) && requestedSize >= 1
    ? Math.floor(requestedSize)
    : DEFAULT_BATCH_SIZE;
  const outcomes = [];
  for (let start = 0; start < targets.length; start += size) {
    outcomes.push(await judgeTargetBatch({
      llm,
      signal,
      query,
      targets: targets.slice(start, start + size),
    }));
  }
  return {
    judgments: outcomes.flatMap((outcome) => outcome.judgments),
    unknown: outcomes.some((outcome) => outcome.unknown),
    retried: outcomes.some((outcome) => outcome.retried),
    attempts: outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0),
    batches: Math.ceil(targets.length / size),
    splitRetries: outcomes.reduce((sum, outcome) => sum + outcome.splitRetries, 0),
  };
}
