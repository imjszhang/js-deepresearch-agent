function readExploratoryRaw(settings = {}) {
  return settings?.research?.exploratory || settings?.research?.adaptive || {};
}

function tokenBound(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function resolveExploratorySettings(settings = {}) {
  const raw = readExploratoryRaw(settings);
  const hasMin = raw.minLlmTokens !== undefined && raw.minLlmTokens !== null && raw.minLlmTokens !== '';
  const hasTarget = raw.targetLlmTokens !== undefined && raw.targetLlmTokens !== null && raw.targetLlmTokens !== '';
  let minLlmTokens = hasMin
    ? tokenBound(raw.minLlmTokens, 0)
    : (hasTarget ? tokenBound(raw.targetLlmTokens, 0) : 20000);
  const maxLlmTokens = tokenBound(raw.maxLlmTokens, raw.maxLlmTokens === undefined || raw.maxLlmTokens === null ? 80000 : 0);
  if (minLlmTokens > 0 && maxLlmTokens > 0 && minLlmTokens > maxLlmTokens) {
    minLlmTokens = maxLlmTokens;
  }
  return {
    maxSteps: Number(raw.maxSteps) || 16,
    minLlmTokens,
    maxLlmTokens,
    targetLlmTokens: minLlmTokens,
    maxGapDepth: Number(raw.maxGapDepth) || 2,
    maxOpenGaps: Number(raw.maxOpenGaps) || 8,
    maxQueriesPerStep: Number(raw.maxQueriesPerStep) || 3,
    maxReadsPerStep: Number(raw.maxReadsPerStep) || 4,
    plannerParallelism: Number(raw.plannerParallelism) || 2,
    enableCoding: raw.enableCoding === true,
    gateMode: raw.gateMode || 'rules-then-llm',
    maxEvaluationRetries: raw.maxEvaluationRetries === undefined ? 1 : Number(raw.maxEvaluationRetries),
    answerGate: raw.answerGate !== false,
    autoReadTopK: raw.autoReadTopK,
  };
}

export function applyExploratoryTokenBudget(budget, exploratory) {
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
