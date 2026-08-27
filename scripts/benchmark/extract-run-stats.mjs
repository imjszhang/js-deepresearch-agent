import { mapHistoricalStrategy } from 'js-deepresearch-engine';

export function resolveStrategyLabel(artifacts) {
  const strategy = artifacts.meta?.strategy || 'unknown';
  return mapHistoricalStrategy(strategy, {
    meta: artifacts.meta,
    trace: artifacts.trace,
    settings: artifacts.meta?.settings,
  });
}

export function durationFromTrace(trace = []) {
  if (!trace.length) return null;

  const stepDurations = trace
    .map((entry) => entry.durationMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (stepDurations.length > 0) {
    return stepDurations.reduce((sum, value) => sum + value, 0);
  }

  const timestamps = trace
    .map((entry) => Date.parse(entry.createdAt))
    .filter(Number.isFinite);
  if (timestamps.length < 2) return null;
  return Math.max(...timestamps) - Math.min(...timestamps);
}

export function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'n/a';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function countLlmPurposeCalls(trace = []) {
  const entries = Array.isArray(trace) ? trace : [];
  const purposes = {};

  for (const entry of entries) {
    if (entry.action !== 'llm_call' || entry.status !== 'completed') continue;
    const purpose = entry.purpose || entry.reasonCode || 'unknown';
    purposes[purpose] = (purposes[purpose] || 0) + 1;
  }

  return {
    purposes,
    sourceSummaryCalls: purposes.source_summary || 0,
    totalCompletedLlmCalls: Object.values(purposes).reduce((sum, count) => sum + count, 0),
  };
}

function llmCallTokens(entry = {}) {
  return Number(entry.tokens ?? entry.totalTokens ?? entry.usage?.totalTokens ?? entry.usage?.total_tokens);
}

function isEvaluationPurpose(purpose = '') {
  return purpose === 'claim_entailment' || /entailment|evaluat/i.test(purpose);
}

export function splitLlmCost({ usage = {}, trace = [] } = {}) {
  const llmTokens = Number(usage.llmTokens) || 0;
  const searchRequests = Number(usage.searchRequests) || 0;
  const sourceReads = Number(usage.sourceReads) || 0;
  const usageExploration = Number(usage.explorationTokens);
  const usageReport = Number(usage.reportTokens);
  const usageEvaluation = Number(usage.evaluationTokens);

  if ([usageExploration, usageReport, usageEvaluation].some((value) => Number.isFinite(value) && value > 0)) {
    return {
      explorationTokens: Number.isFinite(usageExploration) ? usageExploration : 0,
      reportTokens: Number.isFinite(usageReport) ? usageReport : 0,
      evaluationTokens: Number.isFinite(usageEvaluation) ? usageEvaluation : 0,
      llmTokens,
      searchRequests,
      sourceReads,
    };
  }

  const completed = (Array.isArray(trace) ? trace : []).filter(
    (entry) => entry.action === 'llm_call' && entry.status === 'completed',
  );
  if (!completed.length) {
    return {
      explorationTokens: null,
      reportTokens: null,
      evaluationTokens: null,
      llmTokens,
      searchRequests,
      sourceReads,
    };
  }

  const amounts = completed.map((entry) => ({
    purpose: String(entry.purpose || entry.reasonCode || ''),
    tokens: llmCallTokens(entry),
  }));
  if (amounts.some((item) => !Number.isFinite(item.tokens))) {
    return {
      explorationTokens: null,
      reportTokens: null,
      evaluationTokens: null,
      llmTokens,
      searchRequests,
      sourceReads,
    };
  }

  let reportTokens = 0;
  let evaluationTokens = 0;
  let explorationTokens = 0;
  for (const item of amounts) {
    if (item.purpose === 'report') reportTokens += item.tokens;
    else if (isEvaluationPurpose(item.purpose)) evaluationTokens += item.tokens;
    else explorationTokens += item.tokens;
  }

  return {
    explorationTokens,
    reportTokens,
    evaluationTokens,
    llmTokens: llmTokens || (explorationTokens + reportTokens + evaluationTokens),
    searchRequests,
    sourceReads,
  };
}

export function extractRunStats(artifacts, { wallClockDurationMs = null } = {}) {
  const quality = artifacts.quality || {};
  const budget = quality.budget || {};
  const usage = budget.usage || {};
  const traceDurationMs = durationFromTrace(artifacts.trace);
  const durationMs = Number.isFinite(wallClockDurationMs) ? wallClockDurationMs : traceDurationMs;
  const llmPurposes = countLlmPurposeCalls(artifacts.trace);
  const tokenSplit = splitLlmCost({ usage, trace: artifacts.trace });

  return {
    workDir: artifacts.workDir,
    query: artifacts.meta?.query || '',
    strategy: artifacts.meta?.strategy || '',
    strategyLabel: resolveStrategyLabel(artifacts),
    researchId: artifacts.meta?.researchId || null,
    createdAt: artifacts.meta?.createdAt || null,
    durationMs,
    durationLabel: formatDurationMs(durationMs),
    gate: quality.gate || null,
    qualityFlags: Array.isArray(quality.flags) ? quality.flags : [],
    stopReason: quality.stopReason || budget.controllerStopReason || budget.stopReason || null,
    minLlmTokens: budget.minLlmTokens || budget.targetLlmTokens || null,
    targetLlmTokens: budget.minLlmTokens || budget.targetLlmTokens || null,
    actualLlmTokens: usage.llmTokens ?? 0,
    unusedBudgetTokens: budget.unusedBudgetTokens
      ?? (budget.targetLlmTokens > 0 && Number.isFinite(usage.llmTokens)
        ? Math.max(0, budget.targetLlmTokens - usage.llmTokens)
        : (budget.limits?.llmTokens > 0 && Number.isFinite(usage.llmTokens)
          ? Math.max(0, budget.limits.llmTokens - usage.llmTokens)
          : null)),
    cost: {
      llmRequests: usage.llmRequests ?? 0,
      llmTokens: usage.llmTokens ?? 0,
      explorationTokens: tokenSplit.explorationTokens,
      reportTokens: tokenSplit.reportTokens,
      evaluationTokens: tokenSplit.evaluationTokens,
      searchRequests: usage.searchRequests ?? 0,
      sourceReads: usage.sourceReads ?? 0,
      rerankRequests: usage.rerankRequests ?? 0,
      rerankTokens: usage.rerankTokens ?? 0,
      estimatedCost: usage.estimatedCost ?? null,
      estimatedCostUnknown: budget.unknown?.estimatedCost ?? true,
    },
    counts: {
      sourceCount: artifacts.sources?.length || 0,
      findingCount: artifacts.findings?.length || 0,
      passageCount: artifacts.passages?.length || 0,
      claimCount: artifacts.claims?.length || 0,
      traceSteps: artifacts.trace?.length || 0,
      reportChars: artifacts.report?.length || 0,
    },
    llmPurposes,
  };
}
