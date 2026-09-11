const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export function summarizeBudget(budget, supportedCriteria = null) {
  if (!budget) return { available: false, floorStatus: 'unknown', confirmedTokens: null, costPerSupportedCriterion: null };
  const usage = budget.usage || {}, unknown = budget.unknown || {};
  const reservations = [...new Map((budget.reservations || []).map(r => [r.attemptId, r])).values()];
  const confirmedTokens = number(usage.llmTokens);
  return { available: true, confirmedTokens, explorationTokens: number(usage.explorationTokens), reportTokens: number(usage.reportTokens),
    internalEvaluationTokens: number(usage.evaluationTokens), llmCalls: number(usage.llmRequests), searchCalls: number(usage.searchRequests),
    sourceReads: number(usage.sourceReads), rerankCalls: number(usage.rerankRequests),
    floorStatus: ['met', 'unmet', 'unknown'].includes(budget.floorStatus) ? budget.floorStatus : 'unknown',
    unknownUsage: { ...unknown }, unknownCallCount: reservations.filter(r => r.status === 'outcome_unknown').length,
    reservedTokens: reservations.reduce((sum, r) => sum + (number(r.amount) ?? 0), 0),
    settledAttempts: Array.isArray(budget.settledAttemptIds) ? new Set(budget.settledAttemptIds).size : null,
    costPerSupportedCriterion: supportedCriteria > 0 && confirmedTokens != null ? confirmedTokens / supportedCriteria : null,
    costIsLowerBound: unknown.llmTokens === true || reservations.length > 0,
    estimatedCost: unknown.estimatedCost ? null : number(usage.estimatedCost) };
}
