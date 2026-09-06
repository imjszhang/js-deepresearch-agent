import { completeStructuredJson } from './structured-llm.mjs';
import { sourceAssessmentPrompt } from './prompts.mjs';

export const SOURCE_ASSESSMENT_PURPOSE = 'source_assessment';

export const READABILITY_VALUES = Object.freeze(['readable', 'unreadable', 'uncertain']);
export const CONTENT_KIND_VALUES = Object.freeze([
  'article',
  'homepage',
  'product_page',
  'filing',
  'forum',
  'login_wall',
  'error_page',
  'obfuscated',
  'other',
]);
export const PUBLISHER_TYPE_VALUES = Object.freeze([
  'official',
  'regulator',
  'exchange_filing',
  'mainstream_media',
  'aggregator',
  'reseller',
  'mirror',
  'ugc',
  'unknown',
]);
export const EVIDENCE_TIER_VALUES = Object.freeze([
  'other_primary',
  'specialist',
  'mainstream',
  'reprint',
  'ugc',
  'unknown',
]);

const READABILITY = new Set(READABILITY_VALUES);
const CONTENT_KINDS = new Set(CONTENT_KIND_VALUES);
const PUBLISHER_TYPES = new Set(PUBLISHER_TYPE_VALUES);
const EVIDENCE_TIERS = new Set(EVIDENCE_TIER_VALUES);

export const ASSESSMENT_STATUS = Object.freeze({
  ok: 'ok',
  unavailable: 'unavailable',
  skipped: 'skipped',
});

/**
 * Assessment placeholder used when the LLM never produced a usable verdict.
 *
 * `readability` stays `uncertain` because nothing was actually judged; only a
 * real LLM verdict may claim `unreadable`.
 */
export function failClosedAssessment(reason = 'invalid_or_empty_json') {
  return {
    summary: '',
    readability: 'uncertain',
    contentKind: 'other',
    publisherType: 'unknown',
    firstParty: false,
    evidenceTier: 'unknown',
    reason: String(reason || 'invalid_or_empty_json'),
    method: 'fail_closed',
  };
}

export function normalizeSourceAssessment(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failClosedAssessment('invalid_or_empty_json');
  }
  const readability = String(parsed.readability || '').trim();
  if (!READABILITY.has(readability)) return failClosedAssessment('invalid_readability');
  const contentKind = String(parsed.contentKind || '').trim();
  const publisherType = String(parsed.publisherType || '').trim();
  const evidenceTier = String(parsed.evidenceTier || '').trim();
  if (!CONTENT_KINDS.has(contentKind)) return failClosedAssessment('invalid_content_kind');
  if (!PUBLISHER_TYPES.has(publisherType)) return failClosedAssessment('invalid_publisher_type');
  if (!EVIDENCE_TIERS.has(evidenceTier)) return failClosedAssessment('invalid_evidence_tier');
  return {
    summary: String(parsed.summary || '').trim(),
    readability,
    contentKind,
    publisherType,
    firstParty: parsed.firstParty === true,
    evidenceTier,
    reason: String(parsed.reason || '').trim() || null,
    method: 'llm',
  };
}

export function hasUsableSourceAssessment(parsed) {
  return normalizeSourceAssessment(parsed).method === 'llm';
}

export async function assessSourceBody({
  llm,
  signal,
  query = '',
  question = '',
  title = '',
  url = '',
  content = '',
  entities = [],
  preferredHosts = [],
  observedHosts = [],
} = {}) {
  const result = await completeStructuredJson({
    llm,
    signal,
    purpose: SOURCE_ASSESSMENT_PURPOSE,
    maxTokens: 700,
    retryMaxTokens: 700,
    accept: hasUsableSourceAssessment,
    messages: sourceAssessmentPrompt({
      query,
      question,
      title,
      url,
      content,
      entities,
      preferredHosts,
      observedHosts,
    }),
  });
  if (!result.ok) {
    return {
      assessment: failClosedAssessment(result.reason || 'invalid_or_empty_json'),
      status: ASSESSMENT_STATUS.unavailable,
      attempts: result.attempts,
      retried: result.retried,
    };
  }
  const assessment = normalizeSourceAssessment(result.parsed);
  return {
    assessment,
    status: isAssessmentUnavailable(assessment)
      ? ASSESSMENT_STATUS.unavailable
      : ASSESSMENT_STATUS.ok,
    attempts: result.attempts,
    retried: result.retried,
  };
}

/**
 * True when the assessment step itself never produced a verdict (unparseable or
 * out-of-enum LLM output). This is a plumbing outcome, not a content judgment.
 */
export function isAssessmentUnavailable(assessment) {
  return assessment?.method === 'fail_closed';
}

/**
 * Only a real LLM verdict may declare a body unusable. An unavailable
 * assessment leaves the decision to the deterministic body-quality rules.
 */
export function assessmentBlocksSuccessfulBody(assessment) {
  if (!assessment) return false;
  if (isAssessmentUnavailable(assessment)) return false;
  return assessment.readability === 'unreadable';
}
