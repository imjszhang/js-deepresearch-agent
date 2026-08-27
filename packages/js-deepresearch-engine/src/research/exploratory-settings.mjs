function readExploratoryRaw(settings = {}) {
  return settings?.research?.exploratory || settings?.research?.adaptive || {};
}

function tokenBound(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function countBound(raw, fallback = 0) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export const EXPLORATORY_SAFETY_MAX_STEPS = 64;
export const DEFAULT_EXPLORATORY_MIN_LLM_TOKENS = 60000;
export const DEFAULT_EXPLORATORY_MAX_LLM_TOKENS = 200000;

export function effectiveExploratoryMaxSteps(exploratory = {}, tokenCeiling) {
  const configured = countBound(exploratory.maxSteps, 0);
  if (configured > 0) return configured;
  const cap = Number(tokenCeiling ?? exploratory.maxLlmTokens) || 0;
  if (cap > 0) return 0;
  return EXPLORATORY_SAFETY_MAX_STEPS;
}

export function resolveExploratorySettings(settings = {}) {
  const raw = readExploratoryRaw(settings);
  const hasMin = raw.minLlmTokens !== undefined && raw.minLlmTokens !== null && raw.minLlmTokens !== '';
  const hasTarget = raw.targetLlmTokens !== undefined && raw.targetLlmTokens !== null && raw.targetLlmTokens !== '';
  let minLlmTokens = hasMin
    ? tokenBound(raw.minLlmTokens, 0)
    : (hasTarget ? tokenBound(raw.targetLlmTokens, 0) : DEFAULT_EXPLORATORY_MIN_LLM_TOKENS);
  const maxLlmTokens = tokenBound(
    raw.maxLlmTokens,
    raw.maxLlmTokens === undefined || raw.maxLlmTokens === null ? DEFAULT_EXPLORATORY_MAX_LLM_TOKENS : 0,
  );
  if (minLlmTokens > 0 && maxLlmTokens > 0 && minLlmTokens > maxLlmTokens) {
    minLlmTokens = maxLlmTokens;
  }
  return {
    maxSteps: countBound(raw.maxSteps, 0),
    minLlmTokens,
    maxLlmTokens,
    targetLlmTokens: minLlmTokens,
    maxGapDepth: Number(raw.maxGapDepth) || 2,
    maxOpenGaps: Number(raw.maxOpenGaps) || 8,
    maxQueriesPerStep: Number(raw.maxQueriesPerStep) || 3,
    maxReadsPerStep: Number(raw.maxReadsPerStep) || 4,
    maxSearchRequests: countBound(raw.maxSearchRequests, 0),
    maxSourceReads: countBound(raw.maxSourceReads, 0),
    plannerParallelism: Number(raw.plannerParallelism) || 2,
    enableCoding: raw.enableCoding === true,
    gateMode: raw.gateMode || 'rules-then-llm',
    maxEvaluationRetries: raw.maxEvaluationRetries === undefined ? 1 : Number(raw.maxEvaluationRetries),
    answerGate: raw.answerGate !== false,
    autoReadTopK: raw.autoReadTopK,
    profilePlanner: raw.profilePlanner !== false,
    maxUnreadPerHostname: Number(raw.maxUnreadPerHostname) || 2,
    maxCandidateEvaluationTokens: countBound(raw.maxCandidateEvaluationTokens, 0),
    maxPostReportEvaluationTokens: countBound(raw.maxPostReportEvaluationTokens, 0),
  };
}

export function applyExploratoryBudget(budget, exploratory) {
  applyExploratoryTokenLimits(budget, exploratory);
  if (!budget?.limits) return;
  budget.limits.searchRequests = countBound(exploratory?.maxSearchRequests, 0);
  budget.limits.sourceReads = countBound(exploratory?.maxSourceReads, 0);
}

export function applyExploratoryTokenBudget(budget, exploratory) {
  applyExploratoryBudget(budget, exploratory);
}

function applyExploratoryTokenLimits(budget, exploratory) {
  if (!budget) return;
  const min = Number(exploratory?.minLlmTokens) || 0;
  const max = Number(exploratory?.maxLlmTokens) || 0;
  budget.minLlmTokens = min;
  budget.targetLlmTokens = min;
  if (max > 0) {
    const current = Number(budget.limits?.llmTokens) || 0;
    budget.limits.llmTokens = current > 0 ? Math.min(current, max) : max;
  }
  if (typeof budget.updateReportReserve === 'function') {
    budget.updateReportReserve(budget.estimatedReportPromptTokens || 400);
  }
}
