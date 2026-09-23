import { judgeMaySend } from './judge-settings.mjs';
import {
  ASSESSMENT_STATUS,
  CONTENT_KIND_VALUES,
  EVIDENCE_TIER_VALUES,
  PUBLISHER_TYPE_VALUES,
} from './source-assessment.mjs';

export const JUDGE_SOURCE_ASSESSMENT_PURPOSE = 'judge_source_assessment';

const labels = (values) => Object.fromEntries(values.map((value) => [value, null]));

const QUESTIONS = Object.freeze({
  readability: {
    type: 'choice',
    instructions: 'Is `content` a readable document body for `url`, or an unusable page (login wall, challenge, error, obfuscated or binary text)?',
    criteria: { readable: 'Readable document body', unreadable: 'Unusable page with no real document body' },
  },
  contentKind: { type: 'choice', instructions: 'Which kind of page is `content`?', criteria: labels(CONTENT_KIND_VALUES) },
  publisherType: { type: 'choice', instructions: 'Which kind of publisher operates `url` and published `content`?', criteria: labels(PUBLISHER_TYPE_VALUES) },
  evidenceTier: { type: 'choice', instructions: 'Which evidence tier best describes `content` as a source for `question`?', criteria: labels(EVIDENCE_TIER_VALUES) },
  firstParty: { type: 'noul', instructions: 'Is `content` published by one of `entities` itself (first-party), rather than by a third party writing about it?' },
});

const CREDENTIAL_CONTENT_KINDS = new Set(['filing']);
const CREDENTIAL_PUBLISHERS = new Set(['official', 'regulator', 'exchange_filing', 'mainstream_media']);
const CREDENTIAL_TIERS = new Set(['other_primary', 'specialist', 'mainstream']);

/**
 * Verdicts that could satisfy an evidence criterion or raise a source tier are
 * never granted by Jev alone; those sources go through the original LLM assessment.
 */
export function assessmentClaimsCredential(assessment) {
  return assessment.firstParty === true
    || CREDENTIAL_CONTENT_KINDS.has(assessment.contentKind)
    || CREDENTIAL_PUBLISHERS.has(assessment.publisherType)
    || CREDENTIAL_TIERS.has(assessment.evidenceTier);
}

function confident(answer, threshold) {
  return answer.probabilities[answer.choice] >= threshold ? answer.choice : null;
}

/**
 * Maps Jev answers onto the existing assessment enums. Any answer below its
 * threshold makes the whole verdict uncertain so the caller keeps the LLM path.
 */
export function assessmentFromJudgeAnswers(answers, thresholds, identityKey) {
  const readability = answers.readability.choice === 'unreadable'
    ? confident(answers.readability, thresholds.unreadable)
    : confident(answers.readability, thresholds.assessmentConfidence);
  const contentKind = confident(answers.contentKind, thresholds.assessmentConfidence);
  const publisherType = confident(answers.publisherType, thresholds.assessmentConfidence);
  const evidenceTier = confident(answers.evidenceTier, thresholds.assessmentConfidence);
  const firstPartyProbability = answers.firstParty.noul;
  const firstParty = firstPartyProbability >= thresholds.firstParty
    ? true
    : firstPartyProbability <= 1 - thresholds.firstParty ? false : null;
  if (!readability || !contentKind || !publisherType || !evidenceTier || firstParty === null) return null;
  return {
    summary: '',
    readability,
    contentKind,
    publisherType,
    firstParty,
    evidenceTier,
    reason: null,
    method: 'jev',
    judge: identityKey,
  };
}

/**
 * Returns an assessment outcome when Jev gave a confident verdict, otherwise
 * `{ outcome: null }` with a trace so the caller runs the original LLM assessment.
 */
export async function judgeSourceAssessment(judge, {
  signal,
  url = '',
  title = '',
  content = '',
  question = '',
  query = '',
  entities = [],
  preferredHosts = [],
  observedHosts = [],
} = {}) {
  if (!judge?.enabled?.('sourceAssessment')) return null;
  const identity = { provider: judge.provider, model: judge.model };
  if (!judgeMaySend(judge, url)) return { outcome: null, trace: { ...identity, outcome: 'skipped_local_corpus' } };
  const result = await judge.judge({
    purpose: JUDGE_SOURCE_ASSESSMENT_PURPOSE,
    signal,
    state: { question: question || query, url, title, entities, preferredHosts, observedHosts, content },
    questions: QUESTIONS,
  });
  if (result.status !== 'completed') {
    return { outcome: null, trace: { ...identity, outcome: 'degraded', errorCode: result.errorCode || null } };
  }
  const assessment = assessmentFromJudgeAnswers(result.answers, judge.thresholds, judge.identityKey);
  const outcome = !assessment ? 'uncertain' : assessmentClaimsCredential(assessment) ? 'credential_needs_llm' : 'applied';
  const trace = { ...identity, outcome, stateTruncated: result.truncated === true };
  if (outcome !== 'applied') return { outcome: null, trace };
  return { outcome: { assessment, status: ASSESSMENT_STATUS.ok, attempts: 1, retried: false }, trace };
}
