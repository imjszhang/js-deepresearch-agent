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

export function extractRunStats(artifacts, { wallClockDurationMs = null } = {}) {
  const quality = artifacts.quality || {};
  const budget = quality.budget || {};
  const usage = budget.usage || {};
  const traceDurationMs = durationFromTrace(artifacts.trace);
  const durationMs = Number.isFinite(wallClockDurationMs) ? wallClockDurationMs : traceDurationMs;
  const llmPurposes = countLlmPurposeCalls(artifacts.trace);

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
    targetLlmTokens: budget.targetLlmTokens || null,
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
