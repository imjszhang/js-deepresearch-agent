import { collectObservabilityMetrics, mapHistoricalStrategy } from 'js-deepresearch-engine';

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
    sourceSummaryCalls: (purposes.source_summary || 0) + (purposes.source_assessment || 0),
    sourceAssessmentCalls: purposes.source_assessment || 0,
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
  const expectedSlots = artifacts.brief?.requiredAnswerSlots || [];
  const materializedSlotIds = new Set((artifacts.gaps || []).map((gap) => gap.contractSlotId).filter(Boolean));
  const dedupTraces = (artifacts.trace || []).filter((entry) => (
    entry.purpose === 'query_dedup_batch' || entry.reasonCode === 'query_dedup_batch'
  ));
  const relevance = quality.metrics?.relevance || {};
  const recovery = quality.metrics?.recovery || {
    invalidSteps: 0,
    recoveryRounds: 0,
    duplicateQueryRejections: 0,
    siteFilteredAllQueries: 0,
    siteFallbackQueries: 0,
    blockedGaps: [],
  };
  const searchTraces = (artifacts.trace || []).filter((entry) => entry.action === 'search');
  const executedSearches = searchTraces.filter((entry) => (
    !['rejected', 'skipped'].includes(entry.status)
  ));
  const queriesMissingProvenance = executedSearches.filter((entry) => !entry.queryOrigin && !entry.plannedQueries).length;
  const ruleGeneratedQueryCount = executedSearches.filter((entry) => (
    entry.queryOrigin && !['user_query', 'llm_planner'].includes(entry.queryOrigin)
  )).length + executedSearches.filter((entry) => (
    /primary source evidence|conflicting evidence correction|counterexample failure/i.test(String(entry.query || (entry.queries || []).join(' ')))
  )).length;
  const siteFallbackWithoutPlanner = searchTraces.filter((entry) => (
    (entry.reasonCode === 'site_fallback_query' || entry.siteFallbackOf)
    && entry.queryOrigin !== 'llm_planner'
  )).length;
  const queryProvenance = quality.metrics?.queryProvenance || {
    queriesMissingProvenance,
    ruleGeneratedQueryCount,
    plannerRejectedQueries: Number(recovery.plannerRejectedQueries) || 0,
    plannerRetryCount: Number(recovery.plannerRetryCount) || 0,
    siteFallbackWithoutPlanner,
  };
  const successfulEvidenceEntries = (artifacts.trace || []).filter((entry) => (
    (entry.action === 'read' && Number(entry.successfulBodies) > 0)
    || (entry.action === 'search' && (Number(entry.newUrlCount) > 0 || Number(entry.resultCount) > 0))
  ));
  const lastEvidenceTokens = successfulEvidenceEntries.length
    ? Number(successfulEvidenceEntries.at(-1)?.budgetAfter?.usage?.llmTokens) || 0
    : 0;
  const zeroEvidenceTailTokens = tokenSplit.explorationTokens == null
    ? null
    : Math.max(0, Number(tokenSplit.explorationTokens) - lastEvidenceTokens);
  const relevanceFunnel = {
    returnedCandidates: Number(relevance.returnedCandidates) || 0,
    siteRejected: Number(relevance.siteRejected) || 0,
    admittedCandidates: Number(relevance.admittedCandidates) || 0,
    rerankEvaluated: Number(relevance.rerankEvaluated) || 0,
    rerankAccepted: Number(relevance.rerankAccepted) || 0,
    rerankRejected: Number(relevance.rerankRejected) || 0,
    bodyIrrelevant: Number(relevance.bodyIrrelevant) || 0,
    readAccepted: Number(relevance.readAccepted) || 0,
  };

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
    stopDetail: quality.stopDetail || budget.controllerStopDetail || null,
    minLlmTokens: budget.minLlmTokens || budget.targetLlmTokens || null,
    targetLlmTokens: budget.minLlmTokens || budget.targetLlmTokens || null,
    actualLlmTokens: usage.llmTokens ?? 0,
    unusedFloorTokens: budget.unusedMinTokens ?? null,
    unusedHardCapTokens: budget.unusedHardCapTokens ?? null,
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
      rerankTokensUnknown: budget.unknown?.rerankTokens ?? false,
      estimatedCost: usage.estimatedCost ?? null,
      estimatedCostUnknown: budget.unknown?.estimatedCost ?? true,
    },
    slotMaterialization: {
      expected: expectedSlots.length,
      materialized: expectedSlots.filter((slot) => materializedSlotIds.has(slot.id)).length,
      missing: expectedSlots.filter((slot) => !materializedSlotIds.has(slot.id)).map((slot) => slot.id),
    },
    queryDedup: {
      batchCalls: dedupTraces.length,
      embeddedQueries: dedupTraces.reduce((sum, entry) => sum + (Number(entry.inputCount) || 0), 0),
      cacheHits: dedupTraces.reduce((sum, entry) => sum + (Number(entry.cacheHits) || 0), 0),
    },
    relevanceFunnel: {
      ...relevanceFunnel,
      siteBalanced: relevanceFunnel.returnedCandidates
        === relevanceFunnel.siteRejected + relevanceFunnel.admittedCandidates,
      rerankBalanced: relevanceFunnel.rerankEvaluated
        === relevanceFunnel.rerankAccepted + relevanceFunnel.rerankRejected,
    },
    recovery,
    queryProvenance: {
      ...queryProvenance,
      queriesMissingProvenance,
      ruleGeneratedQueryCount,
      plannerRejectedQueries: Number(queryProvenance.plannerRejectedQueries || recovery.plannerRejectedQueries) || 0,
      plannerRetryCount: Number(queryProvenance.plannerRetryCount || recovery.plannerRetryCount) || 0,
      siteFallbackWithoutPlanner,
    },
    zeroEvidenceTailTokens,
    counts: {
      sourceCount: artifacts.sources?.length || 0,
      findingCount: artifacts.findings?.length || 0,
      passageCount: artifacts.passages?.length || 0,
      claimCount: artifacts.claims?.length || 0,
      traceSteps: artifacts.trace?.length || 0,
      reportChars: artifacts.report?.length || 0,
    },
    llmPurposes,
    observability: extractDescriptiveObservability(artifacts),
  };
}

export function extractDescriptiveObservability(artifacts = {}) {
  const stored = artifacts.quality?.metrics?.observability;
  const traces = artifacts.trace || [];
  const searches = traces.filter((entry) => entry.action === 'search');
  const hasNew = Boolean(stored)
    || searches.some((entry) => (
      (entry.respondedEngines || []).length
      || (entry.unresponsiveEngines || []).length
      || entry.outcome
      || entry.searchOptions
    ))
    || traces.some((entry) => (
      entry.action === 'slot_support' && (entry.cacheHits != null || entry.cacheMisses != null)
    ))
    || (artifacts.findings || []).some((finding) => (
      (finding.sources || []).some((source) => source.assessment)
    ));
  if (!hasNew) {
    return {
      available: false,
      respondedEngines: null,
      unresponsiveEngines: null,
      queryOutcomes: null,
      sourceAssessment: null,
      slotSupportCache: null,
      agentSnapshotChars: null,
    };
  }
  const computed = stored || collectObservabilityMetrics({
    findings: artifacts.findings,
    trace: traces,
  });
  return {
    available: true,
    respondedEngines: computed.respondedEngines ?? null,
    unresponsiveEngines: computed.unresponsiveEngines ?? null,
    queryOutcomes: computed.queryOutcomes ?? null,
    sourceAssessment: computed.sourceAssessment ?? null,
    slotSupportCache: computed.slotSupportCache ?? null,
    agentSnapshotChars: computed.agentSnapshotChars ?? null,
  };
}
