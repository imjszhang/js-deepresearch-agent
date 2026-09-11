import { createHash } from 'node:crypto';
import { isSuccessfulBody } from './body-quality.mjs';
import { passageContainsQuote } from './claim-entailment.mjs';
import {
  collectUserNamedHosts,
  criterionPoolSignature,
  evaluateEvidenceCriteria,
  normalizeEvidenceCriteria,
  passageSatisfiesCriterion,
  sourceLooksOfficial,
} from './evidence-criteria.mjs';
import { isRequiredSlot, needsSemanticClose } from './gap-state.mjs';
import { splitContentForPassages, tokenOverlapScore } from './passage-utils.mjs';
import { gapSlotSupportPrompt } from './prompts.mjs';
import { completeStructuredJson } from './structured-llm.mjs';
import { normalizeClaimCandidates, VALIDATION_PROTOCOL_VERSION } from './claim-candidates.mjs';
import { isExecutionInterruption } from '../search/search-health.mjs';

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

export function collectSuccessfulPassages(findings = [], {
  gapId = null,
  contractSlotId = null,
  answerSlot = null,
  allowFallback = true,
} = {}) {
  const targeted = Boolean(gapId || contractSlotId || answerSlot);
  const dedicatedFindings = findings.filter((finding) => (
    !targeted
    || finding.gapId === gapId
    || (contractSlotId && finding.contractSlotId === contractSlotId)
    || (!finding.gapId && !finding.contractSlotId && answerSlot && finding.answerSlot === answerSlot)
  ));
  const toPassages = (items) => items.flatMap((finding) => (
    (finding.sources || []).filter(isSuccessfulBody).map((source) => {
      const text = String(source.content || source.summary || '').trim();
      if (!text) return null;
      return {
        id: (source.passageIds && source.passageIds[0]) || `body:${sourceIdentity(source)}`,
        sourceId: source.canonicalSourceId || sourceIdentity(source),
        documentVersionId: source.documentVersionId || null,
        url: source.url || null,
        text,
        gapId: finding.gapId || null,
        assessment: source.assessment || null,
        assessmentStatus: source.assessmentStatus || null,
      };
    }).filter(Boolean)
  ));
  const dedicated = toPassages(dedicatedFindings);
  if (targeted && dedicatedFindings.length) return dedicated;
  if (!allowFallback) return dedicated;
  return dedicated.length ? dedicated : toPassages(findings);
}

function passageKey(passage) {
  return `${passage.sourceId || ''}:${passage.startChar ?? 0}:${passage.endChar ?? 0}:${passage.id || ''}`;
}

function criteriaExtras(gap, extras = {}) {
  return {
    ...extras,
    gap,
    query: extras.query || extras.brief?.query || '',
    brief: extras.brief || {},
    profile: extras.profile || {},
    userNamedHosts: extras.userNamedHosts || collectUserNamedHosts({
      query: extras.query || extras.brief?.query || '',
      brief: extras.brief,
      profile: extras.profile,
    }),
  };
}

export function dedicatedSlotSources(gap, findings = []) {
  return collectSuccessfulPassages(findings, {
    gapId: gap.id,
    contractSlotId: gap.contractSlotId,
    answerSlot: gap.answerSlot,
    allowFallback: !isRequiredSlot(gap),
  });
}

export function selectSlotPassages(gap, findings = [], {
  topK = 3,
  chunkChars = DEFAULT_CHUNK_CHARS,
  brief,
  query,
  profile,
  evidenceStore = null,
  inspectUnseen = false,
} = {}) {
  const extras = criteriaExtras(gap, { brief, query, profile });
  const criteria = normalizeEvidenceCriteria(gap.evidenceCriteria);
  const focus = [
    gap.question,
    gap.answerSlot,
    ...criteria,
    ...(brief?.consequentialClaims || []),
    ...(gap.slotSupport?.missingFacets || []),
  ].filter(Boolean).join(' ');
  const ranked = dedicatedSlotSources(gap, findings)
    .flatMap((passage) => {
      const chunks = evidenceStore && passage.documentVersionId
        ? evidenceStore.chunks(passage.documentVersionId, chunkChars)
        : splitContentForPassages(passage.text, chunkChars);
      const fallback = {
        text: passage.text.slice(0, chunkChars),
        startChar: 0,
        endChar: Math.min(passage.text.length, chunkChars),
      };
      return (chunks.length ? chunks : [fallback]).map((chunk) => ({
        ...passage,
        ...(chunk.documentVersionId ? { id: chunk.id, documentVersionId: chunk.documentVersionId, neighborIds: chunk.neighborIds } : {}),
        text: chunk.text,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        section: chunk.section,
        retrievalScore: tokenOverlapScore(focus, chunk.text),
      }));
    })
    .filter((passage) => !inspectUnseen || !evidenceStore?.checked(gap.id, passage, { questionRevision: gap.questionRevision || 1,
      criterionRevision: gap.criterionRevision || 1, validationProtocolVersion: VALIDATION_PROTOCOL_VERSION }))
    .sort((left, right) => (right.retrievalScore || 0) - (left.retrievalScore || 0));
  const selected = [];
  const used = new Set();
  for (const criterion of criteria) {
    const match = ranked.find((passage) => (
      !used.has(passageKey(passage))
      && passageSatisfiesCriterion(passage, criterion, extras)
    ));
    if (match) {
      selected.push(match);
      used.add(passageKey(match));
    }
  }
  const bySource = new Map();
  for (const passage of ranked) {
    if (!bySource.has(passage.sourceId)) bySource.set(passage.sourceId, passage);
  }
  const diverse = [...bySource.values()].sort((left, right) => (
    (right.retrievalScore || 0) - (left.retrievalScore || 0)
  ));
  const rest = ranked.filter((passage) => !diverse.includes(passage));
  // Direct answer quality precedes source diversity; ties retain a diverse view.
  const remaining = evidenceStore ? [...ranked].sort((a, b) => b.retrievalScore - a.retrievalScore
    || Number(used.has(passageKey(a))) - Number(used.has(passageKey(b)))) : [...diverse, ...rest];
  for (const passage of remaining) {
    if (selected.length >= topK) break;
    if (used.has(passageKey(passage))) continue;
    selected.push(passage);
    used.add(passageKey(passage));
  }
  return selected.slice(0, topK);
}

export function slotSupportFingerprint(gap, passages = [], extras = {}) {
  const criteria = normalizeEvidenceCriteria(gap?.evidenceCriteria);
  const payload = JSON.stringify({
    gapId: gap?.id || '',
    question: gap?.question || '',
    answerSlot: gap?.answerSlot || '',
    contractSlotId: gap?.contractSlotId || '',
    taskType: gap?.taskType || 'fact',
    questionRevision: gap?.questionRevision || 1,
    criterionRevision: gap?.criterionRevision || 1,
    inspectionProtocol: passages.some((passage) => passage.documentVersionId) ? VALIDATION_PROTOCOL_VERSION : 1,
    previousSupport: passages.some((passage) => passage.documentVersionId) && gap?.slotSupport?.quoteAnchored
      ? { verdict: gap.slotSupport.verdict, answer: gap.slotSupport.answer, quote: gap.slotSupport.quote, passageIds: gap.slotSupport.supportingPassageIds, counterPassageIds: gap.slotSupport.contradictingPassageIds } : null,
    evidenceCriteria: criteria,
    passages: (passages || []).map((passage) => ({
      id: passage.id,
      startChar: passage.startChar ?? 0,
      endChar: passage.endChar ?? 0,
      hash: createHash('sha256').update(String(passage.text || '')).digest('hex'),
      firstParty: passage.assessment?.firstParty === true,
      publisherType: passage.assessment?.publisherType || null,
      contentKind: passage.assessment?.contentKind || null,
      evidenceTier: passage.assessment?.evidenceTier || null,
    })),
    criterionPool: extras.criterionPool || {},
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function describeSlotSelection(gap, passages = [], extras = {}) {
  const evaluation = extras.evaluation || evaluateEvidenceCriteria({
    gap,
    sources: extras.sources || passages,
    passages,
    extras,
  });
  return {
    gapId: gap?.id || null,
    selectedSourceIds: unique((passages || []).map((passage) => passage.sourceId)),
    evidenceTypes: evaluation.labels || [],
    missingCriteria: evaluation.missing || [],
  };
}

export function officialSlotSourceIds(gap, findings = [], extras = {}) {
  return unique(
    dedicatedSlotSources(gap, findings)
      .filter((passage) => sourceLooksOfficial(passage, gap, extras))
      .map((passage) => passage.sourceId),
  );
}

function supportSourceIds(support = {}) {
  return unique([
    ...(support.officialSourceIds || []),
    ...(support.evidenceSourceIds || []),
    ...(support.supportingPassageIds || []).map((id) => (
      String(id || '').startsWith('body:') ? String(id).slice(5) : id
    )),
  ]);
}

export function hasUnseenOfficialSlotEvidence(gap, findings = [], extras = {}) {
  const official = officialSlotSourceIds(gap, findings, extras);
  if (!official.length) return false;
  const seen = new Set(supportSourceIds(gap?.slotSupport));
  return official.some((id) => !seen.has(id));
}

export function slotsNeedingSupport(gaps = [], extras = {}) {
  const findings = extras.findings || [];
  return gaps.filter((gap) => {
    if (gap?.rollup) return false;
    if (!extras.evidenceStore && !needsSemanticClose(gap) && !isRequiredSlot(gap)) return false;
    const closed = gap.status === 'verified'
      && gap.slotSupport?.verdict === 'supported'
      && gap.slotSupport?.quoteAnchored === true;
    if (closed && extras.evidenceStore && extras.inspectUnseen) return true;
    if (closed) return hasUnseenOfficialSlotEvidence(gap, findings, extras);
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

function normalizeJudgment(raw = {}, passages = [], previousPassages = []) {
  let claimCandidates;
  try { claimCandidates = normalizeClaimCandidates(raw.claimCandidates, [...passages, ...previousPassages]); }
  catch { return failClosedSupport('invalid_claim_candidates'); }
  const verdict = String(raw.verdict || '').trim();
  const quote = String(raw.quote || '').trim();
  const passageIds = new Set([...passages, ...previousPassages].map((passage) => passage.id));
  const supportingPassageIds = unique(raw.supportingPassageIds).filter((id) => passageIds.has(id));
  const contradictingPassageIds = unique(raw.contradictingPassageIds).filter((id) => passageIds.has(id));
  if (!VERDICTS.has(verdict)) return failClosedSupport('invalid_verdict');
  const negativeWithoutQuote = ['unsupported', 'unverifiable'].includes(verdict) && !quote;
  if (!negativeWithoutQuote && !passageContainsQuote(passages, quote)) return failClosedSupport('quote_not_in_body');
  const quoted = passages.find((passage) => passageContainsQuote([passage], quote));
  return {
    gapId: raw.gapId || null,
    answerSlot: raw.answerSlot || null,
    question: raw.question || null,
    verdict,
    answer: String(raw.answer || '').trim().slice(0, 4000),
    claimCandidates,
    missingFacets: Array.isArray(raw.missingFacets) ? raw.missingFacets.filter((item) => typeof item === 'string').map((item) => item.slice(0, 400)).slice(0, 10) : [],
    quote,
    supportingPassageIds: passages.some((passage) => passage.documentVersionId)
      ? unique([...supportingPassageIds, ...(quoted?.id ? [quoted.id] : [])])
      : supportingPassageIds.length ? supportingPassageIds : (quoted?.id ? [quoted.id] : []),
    contradictingPassageIds,
    reason: String(raw.reason || '').trim() || null,
    method: 'llm',
    quoteAnchored: !negativeWithoutQuote,
    inspectionComplete: true,
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
    if (!judgment) continue;
    const prior = gap.slotSupport;
    const incomingFailedClosed = judgment.method === 'fail_closed' || judgment.quoteAnchored !== true;
    const priorAnchored = prior?.method === 'llm' && prior?.quoteAnchored === true;
    const narrowerInspection = judgment.inspectionScope === 'selected_ranges'
      && prior?.verdict === 'supported' && judgment.verdict === 'partially_supported';
    if ((incomingFailedClosed || narrowerInspection) && priorAnchored) {
      gap.slotSupport = {
        ...prior,
        claimCandidates: [...new Map([...(prior.claimCandidates || []), ...(judgment.claimCandidates || [])].map(c => [c.candidateId, c])).values()],
        officialSourceIds: unique([
          ...(prior.officialSourceIds || []),
          ...(judgment.officialSourceIds || []),
        ]),
        evidenceSourceIds: unique([
          ...(prior.evidenceSourceIds || []),
          ...(judgment.evidenceSourceIds || []),
        ]),
      };
      continue;
    }
    gap.slotSupport = { ...judgment, claimCandidates: [...new Map([...(prior?.claimCandidates || []), ...(judgment.claimCandidates || [])]
      .map(c => [c.candidateId, c])).values()] };
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
  if (targets.every(target => target.passages.every(p => p.documentVersionId))) {
    return judgments.length === targets.length && new Set(judgments.map(j => j.gapId)).size === targets.length
      && targets.every(({ gap }) => judgments.some(j => j.gapId === gap.id));
  }
  if (targets.length === 1 && judgments.length === 1) return true;
  return targets.every(({ gap }) => Boolean(matchJudgment(gap, judgments)));
}

function normalizeBatchJudgments(targets, parsed) {
  const rawJudgments = judgmentsFromParsed(parsed);
  return targets.map(({ gap, passages, previousPassages }) => {
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
      }, passages, previousPassages),
      gapId: gap.id,
      answerSlot: gap.answerSlot || matched.answerSlot || null,
      question: gap.question || matched.question || null,
    };
  });
}

async function judgeTargetBatch({ llm, signal, query, targets }) {
  const maxTokens = targets.some(target => target.passages.some(p => p.documentVersionId))
    ? Math.max(2000, targets.length * 1800) : Math.max(800, targets.length * 600);
  try {
    const result = await completeStructuredJson({
      llm,
      signal,
      purpose: 'gap_support',
      maxTokens,
      retryMaxTokens: maxTokens + 400,
      accept: (parsed) => hasCompleteBatchPayload(parsed, targets)
        && (!targets.every((target) => target.passages.every((passage) => passage.documentVersionId))
          || normalizeBatchJudgments(targets, parsed).every((judgment) => judgment.method !== 'fail_closed')),
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
    if (error?.name === 'AbortError' || error?.name === 'BudgetExceededError' || signal?.aborted || isExecutionInterruption(error)) throw error;
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

function attachEvidenceMeta(judgment, target, extras = {}) {
  if (!judgment || !target) return judgment;
  return {
    ...judgment,
    ...(extras.evidenceStore ? { inspectionScope: 'selected_ranges' } : {}),
    evidenceSourceIds: unique([...(target.passages || []).map((passage) => passage.sourceId),
      ...(judgment.supportingPassageIds || []).map((key) => extras.evidenceStore?.passages.get(key)?.sourceId)]),
    officialSourceIds: officialSlotSourceIds(target.gap, extras.findings || [], extras),
  };
}

function emptySupportResult(extra = {}) {
  return {
    judgments: [],
    unknown: false,
    retried: false,
    attempts: 0,
    batches: 0,
    splitRetries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    selections: [],
    ...extra,
  };
}

export async function judgeOpenSlotSupport({
  llm,
  signal,
  query,
  gaps = [],
  findings = [],
  brief = {},
  profile = {},
  topK = 5,
  batchSize = DEFAULT_BATCH_SIZE,
  cache = null,
  evidenceStore = null,
  inspectUnseen = false,
  onlyGapIds = null,
} = {}) {
  evidenceStore?.captureFindings(findings);
  const extras = { brief, query, profile, findings, evidenceStore, inspectUnseen };
  const targets = [];
  for (const gap of slotsNeedingSupport(gaps, extras)) {
    if (onlyGapIds && !onlyGapIds.includes(gap.id)) continue;
    const sources = dedicatedSlotSources(gap, findings);
    const passages = selectSlotPassages(gap, findings, { topK, brief, query, profile, evidenceStore, inspectUnseen });
    if (!passages.length) continue;
    const evaluation = evaluateEvidenceCriteria({
      gap,
      sources,
      passages: sources,
      extras,
    });
    const criterionPool = criterionPoolSignature(evaluation);
    targets.push({
      gap,
      passages,
      previousPassages: evidenceStore && gap.slotSupport?.quoteAnchored
        ? (gap.slotSupport.supportingPassageIds || []).map((key) => evidenceStore.passages.get(key)).filter(Boolean) : [],
      evaluation,
      slotMode: ['derived_judgment', 'comparison'].includes(gap.taskType) || (!brief.executionVersion && brief?.queryShape === 'judgment') ? 'research_judgment' : 'source_fact',
      consequentialClaims: brief?.consequentialClaims || [],
      cacheKey: slotSupportFingerprint(gap, passages, { criterionPool }),
      selection: describeSlotSelection(gap, passages, { evaluation, extras }),
    });
  }
  if (!targets.length) return emptySupportResult();

  const cachedJudgments = [];
  const pending = [];
  const selections = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const target of targets) {
    const cached = cache?.has(target.cacheKey);
    selections.push({
      ...target.selection,
      cacheHit: Boolean(cached),
      missingCriteria: target.evaluation.missing,
    });
    if (cached) {
      cacheHits += 1;
      cachedJudgments.push(attachEvidenceMeta({
        ...cache.get(target.cacheKey),
        gapId: target.gap.id,
        answerSlot: target.gap.answerSlot || null,
        question: target.gap.question || null,
      }, target, extras));
    } else {
      cacheMisses += 1;
      pending.push(target);
    }
  }

  if (!pending.length) {
    return emptySupportResult({
      judgments: cachedJudgments,
      unknown: cachedJudgments.some((item) => item.method === 'fail_closed'),
      cacheHits,
      cacheMisses,
      selections,
    });
  }

  if (!llm?.complete) {
    return emptySupportResult({
      judgments: [...cachedJudgments, ...failClosedTargets(pending, 'no_llm')],
      unknown: true,
      cacheHits,
      cacheMisses,
      selections,
    });
  }

  const requestedSize = Number(batchSize);
  const size = Number.isFinite(requestedSize) && requestedSize >= 1
    ? Math.floor(requestedSize)
    : DEFAULT_BATCH_SIZE;
  const outcomes = [];
  for (let start = 0; start < pending.length; start += size) {
    outcomes.push(await judgeTargetBatch({
      llm,
      signal,
      query,
      targets: pending.slice(start, start + size),
    }));
  }
  const judged = outcomes.flatMap((outcome) => outcome.judgments).map((judgment) => {
    const target = pending.find((item) => item.gap.id === judgment.gapId);
    if (evidenceStore && target?.gap.slotSupport?.quoteAnchored && judgment.quoteAnchored
      && ['supported', 'partially_supported', 'conflicting'].includes(judgment.verdict)) {
      const previousIds = (target.gap.slotSupport.supportingPassageIds || []).filter((key) => evidenceStore.passages.has(key));
      const opposingIds = target.passages.filter((passage) => passageContainsQuote([passage], judgment.quote)).map((passage) => passage.id);
      if (judgment.verdict === 'conflicting') judgment.supportingPassageIds = unique([...previousIds, ...judgment.supportingPassageIds]);
      judgment.contradictingPassageIds = unique([...(target.gap.slotSupport.contradictingPassageIds || [])
        .filter((key) => evidenceStore.passages.has(key)), ...judgment.contradictingPassageIds]);
      if (judgment.verdict === 'conflicting') judgment.contradictingPassageIds = unique([...judgment.contradictingPassageIds, ...opposingIds]);
    }
    if (evidenceStore && judgment.inspectionComplete && target) {
      for (const documentVersionId of unique(target.passages.map((passage) => passage.documentVersionId))) {
        const passages = target.passages.filter((passage) => passage.documentVersionId === documentVersionId);
        evidenceStore.recordInspection({ taskId: target.gap.id, documentVersionId, passageIds: passages.map((passage) => passage.id),
          questionRevision: target.gap.questionRevision || 1, criterionRevision: target.gap.criterionRevision || 1,
          validationProtocolVersion: VALIDATION_PROTOCOL_VERSION,
          verdict: passages.some((passage) => (judgment.contradictingPassageIds || []).includes(passage.id)) ? 'contradicted'
            : passages.some((passage) => (judgment.supportingPassageIds || []).includes(passage.id)) && ['supported', 'partially_supported'].includes(judgment.verdict) ? 'supported' : 'checked_without_support', missingFacets: judgment.missingFacets });
      }
    }
    return attachEvidenceMeta(judgment, target, extras);
  });
  if (cache) {
    for (const target of pending) {
      const judgment = judged.find((item) => item.gapId === target.gap.id);
      if (judgment) cache.set(target.cacheKey, judgment);
    }
  }
  return {
    judgments: [...cachedJudgments, ...judged],
    unknown: outcomes.some((outcome) => outcome.unknown)
      || cachedJudgments.some((item) => item.method === 'fail_closed'),
    retried: outcomes.some((outcome) => outcome.retried),
    attempts: outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0),
    batches: Math.ceil(pending.length / size),
    splitRetries: outcomes.reduce((sum, outcome) => sum + outcome.splitRetries, 0),
    cacheHits,
    cacheMisses,
    selections,
  };
}
