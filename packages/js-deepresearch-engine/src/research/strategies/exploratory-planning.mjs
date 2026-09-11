import { evidenceStatusOf, isRepairTerminal } from '../gap-state.mjs';
import { evaluateSourceRelevance, inferEvidenceScope } from '../adaptive/source-policy.mjs';
import { nextSlotRepairAction } from '../adaptive/slot-repair-scheduler.mjs';
import { listNotRetrievedLiteralRequiredHosts } from '../adaptive/readiness-gate.mjs';
import { planSearchQueries } from '../search-query-planner.mjs';
import { plannerFeedbackFromState } from '../planner-feedback.mjs';
import { candidateContentFingerprint, rerankEvaluationKey } from '../adaptive/research-state.mjs';
import { normalizeQuery, querySimilarity } from '../query-memory.mjs';
import { EXPLORATORY_STOP_REASONS } from '../adaptive/stop-reasons.mjs';

export const STOP_REASONS = {
  evidenceSufficient: EXPLORATORY_STOP_REASONS.evidenceSufficient,
  budgetExhausted: EXPLORATORY_STOP_REASONS.budgetExhausted,
  safetyCap: EXPLORATORY_STOP_REASONS.safetyCap,
  userCancelled: EXPLORATORY_STOP_REASONS.userCancelled,
  contractUnavailable: EXPLORATORY_STOP_REASONS.contractUnavailable,
};

export const FINALIZE_ACTIONS = new Set(['answer', 'finalize', 'stop', 'draft']);

export function abort(signal) {
  signal?.throwIfAborted?.();
}

export function addTrace(trace, state, action, fields, budget, status = 'success') {
  trace?.push({
    step: trace.length + 1,
    loopStep: state.step,
    action,
    status,
    ...fields,
    budgetAfter: budget?.snapshot?.() || null,
    createdAt: new Date().toISOString(),
  });
}

export function loopCanAfford(budget, tokens) {
  if (!budget || !budget.limits?.llmTokens) return true;
  return budget.canClaim('llmTokens', Math.max(1, Number(tokens) || 1));
}

export function hasStepCap(maxSteps) {
  return Number(maxSteps) > 0;
}

export function dynamicGapCount(state) {
  return state.gaps.filter((gap) => !gap.rollup && !gap.requiredSlot).length;
}

export function countCapsExhausted(budget) {
  return Boolean(budget?.exhaustionDetail?.({ llmClaim: 0 }));
}

export function attachLoopMeta(findings, meta) {
  Object.defineProperty(findings, 'exploratoryLoop', {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return findings;
}

export function selectedFinding(state, sourceIds, gapId) {
  const sources = sourceIds.map((id) => state.candidates.get(id)).filter(Boolean);
  const gap = state.gaps.find((item) => item.id === gapId) || state.gaps[0];
  return {
    question: gap.question,
    gapId: gap.id,
    contractSlotId: gap.contractSlotId || null,
    parentGapId: gap.parentGapId || null,
    answerSlot: gap.answerSlot || null,
    sources,
  };
}

export function addSerpKnowledge(state, results, gapId) {
  const top = (results || []).slice(0, 3)
    .map((result) => [result.title, result.snippet].filter(Boolean).join(': '))
    .filter(Boolean);
  if (!top.length) return;
  state.addKnowledge({ gapId, sourceId: null, learned: `SERP: ${top.join(' | ')}` });
}

export function normalizeSearchQueries(action, maxQueries, { evidenceScope } = {}) {
  const queries = Array.isArray(action.queries) ? action.queries : [];
  const merged = [String(action.query || '').trim(), ...queries.map((query) => String(query || '').trim())];
  const unique = [...new Set(merged.filter(Boolean))];
  const scoped = evidenceScope === 'local'
    ? unique.filter((query) => !/\bsite:\s*\S+/i.test(query))
    : unique;
  return scoped.slice(0, maxQueries);
}

export function plannerContext(state, {
  llm,
  signal,
  queryMemory,
  gate = null,
  rejectedQueries = [],
  siteFallbackFor = '',
  search = null,
  gap = null,
} = {}) {
  const target = gap || state.getGap(state.focusGap()?.id);
  const feedback = plannerFeedbackFromState(state, {
    gap: target,
    rejectedQueries,
    queryMemory,
    providerCapabilities: search?.capabilities || null,
  });
  return {
    llm,
    signal,
    query: state.query,
    brief: state.brief,
    readiness: gate || state.readiness,
    siteQueryMode: state.settings?.research?.read?.relevance?.siteQueryMode || 'confirmed',
    evidenceScope: state.evidenceScope || inferEvidenceScope(state.settings),
    ...feedback,
    observedHosts: [...(state.observedHosts || [])],
    siteFallbackFor,
    queryMemory,
    recoveryHosts: listNotRetrievedLiteralRequiredHosts({
      gap: target,
      findings: state.findings,
      query: state.query,
      brief: state.brief,
    }),
  };
}

export function plannerModeForGap(state, gap, fallback = 'repair') {
  const hosts = listNotRetrievedLiteralRequiredHosts({
    gap,
    findings: state.findings,
    query: state.query,
    brief: state.brief,
  });
  if (hosts.length && ['repair', 'recovery'].includes(fallback)) {
    return 'required_host_recovery';
  }
  return fallback;
}

export function recordPlannerMetrics(state, plan, extra = {}) {
  if (!plan) return;
  state.recovery.plannerRetryCount += plan.retried ? 1 : 0;
  state.recovery.plannerRejectedQueries += plan.dedup?.rejected?.length || 0;
  state.recordPlannerRejections(plan.dedup?.rejected || [], { plannerMode: plan.mode });
  if (!plan.ok) {
    state.setPlannerFailure(plan.failure, {
      gapId: extra.gapId || plan.gapId || null,
      stage: extra.stage || plan.mode || 'planner',
      plannerMode: plan.mode,
    });
    return;
  }
  state.clearPlannerFailure({ gapId: extra.gapId || plan.gapId || null });
}

export async function filterDuplicateQueries(queries, { state, queryMemory, gapId, embedding, signal }) {
  const normalized = [...new Set(queries.map(normalizeQuery).filter(Boolean))];
  const allSearched = state.searchedQueries().map(normalizeQuery);
  const gap = state.getGap(gapId);
  const scopedSearched = (gap?.searchedQueries || []).map(normalizeQuery);
  const exhausted = new Set((gap?.exhaustedAngles || []).map(normalizeQuery));
  const preRejected = normalized.filter((query) => (
    allSearched.includes(query)
    || exhausted.has(query)
    || scopedSearched.some((seen) => querySimilarity(seen, query) >= 0.86)
  ));
  const candidates = normalized.filter((query) => !preRejected.includes(query));
  if (!queryMemory?.filterDuplicates) {
    preRejected.forEach(() => state.noteDuplicateQuery?.());
    return candidates;
  }
  const result = await queryMemory.filterDuplicates(candidates, {
    gapId,
    embedding,
    signal,
    traces: state.embeddingTraces,
  });
  preRejected.forEach((query) => {
    state.noteDuplicateQuery?.();
    state.embeddingTraces.push({ purpose: 'query_dedup_decision', gapId, query, rejectedAt: 'deterministic_scope' });
  });
  for (const rejection of result?.rejected || []) {
    if (!rejection) continue;
    state.noteDuplicateQuery?.();
    state.embeddingTraces.push({
      purpose: 'query_dedup_decision',
      gapId,
      query: rejection.query,
      rejectedAt: rejection.reason,
      duplicateOf: rejection.duplicateOf,
      cacheHits: result.cacheHits,
    });
  }
  return result.accepted;
}

export function contractRepairTargets(state, gate) {
  const ids = new Set([
    ...(gate?.unresolvedRequiredGapIds || []),
    ...(gate?.repairGapIds || []),
    ...(gate?.unresolvedCriticalGapIds || []),
  ]);
  return state.gaps.filter((gap) => {
    if (gap.rollup) return false;
    if (['verified', 'resolved'].includes(gap.status)) return false;
    if (ids.size) return ids.has(gap.id);
    return Boolean(gap.requiredSlot || gap.priority === 'critical');
  });
}

export function unresolvedRepairGaps(state, gate) {
  return contractRepairTargets(state, gate);
}

export function hasEligibleUnread(state, gaps = []) {
  return gaps.some((gap) => (state.pickPolicyReads?.(2, gap.id) || []).length > 0);
}

export function allUnresolvedBlocked(state, gate) {
  const targets = contractRepairTargets(state, gate);
  if (!targets.length) return false;
  if (!targets.every((gap) => isRepairTerminal(gap))) return false;
  return !hasEligibleUnread(state, targets);
}

export function persistPlannerExhaustion(state, stopDetail) {
  if (!['query_planner_exhausted', 'repair_exhausted'].includes(stopDetail)) return;
  for (const gap of contractRepairTargets(state, state.readiness)) {
    if (evidenceStatusOf(gap) === 'verified') continue;
    state.markRepairTerminal(gap.id, stopDetail, { phase: 'planner' });
  }
}

export function unlockPlannerTerminalsForHostRecovery(state, stopDetail) {
  if (!['query_planner_exhausted', 'repair_exhausted'].includes(stopDetail)) return [];
  const unlocked = [];
  for (const gap of state.gaps || []) {
    if (gap.rollup || !isRepairTerminal(gap)) continue;
    if (gap.repairState?.phase && gap.repairState.phase !== 'planner') continue;
    const hosts = listNotRetrievedLiteralRequiredHosts({
      gap,
      findings: state.findings,
      query: state.query,
      brief: state.brief,
    });
    if (!hosts.length) continue;
    state.clearRepairTerminal(gap.id);
    gap.repairFailures = 0;
    unlocked.push(gap.id);
  }
  return unlocked;
}

export function applyResumeExploreBudget(budget, { extraSearches = 0, extraReads = 0 } = {}) {
  if (!budget?.limits) return;
  const bump = (key, extra) => {
    const add = Math.max(0, Number(extra) || 0);
    if (!add) return;
    const used = Number(budget.usage?.[key]) || 0;
    const current = Number(budget.limits[key]) || 0;
    budget.limits[key] = current > 0 ? current + add : used + add;
  };
  bump('searchRequests', extraSearches);
  bump('sourceReads', extraReads);
}

export function safetyStopDetail(state, { trigger, transportOnly = false } = {}) {
  if (trigger === 'consecutive_invalid') {
    return transportOnly ? 'transport_blocked' : 'consecutive_invalid_steps';
  }
  if (trigger === 'all_unresolved_blocked') {
    const last = state.recovery.lastPlannerFailure;
    if (last && typeof last === 'object' && last.step === state.step && last.gapId) {
      const remaining = contractRepairTargets(state, state.readiness);
      if (remaining.some((gap) => gap.id === last.gapId && isRepairTerminal(gap)) && last.reason) {
        return 'query_planner_exhausted';
      }
    }
    return 'repair_exhausted';
  }
  return 'repair_exhausted';
}

export function readRejectionTrace(state, action, invalid) {
  const targetGapId = action?.gapId || state.focusGap()?.id;
  const sourceIds = action?.sourceIds || [];
  return {
    reasonCode: invalid,
    sourceIds,
    targetGapId,
    rejectionStage: 'pre-read',
    reads: sourceIds.map((id) => {
      const candidate = state.candidates.get(id);
      const decision = state.candidateDecisionForGap?.(candidate, targetGapId)
        || candidate?.relevanceDecision
        || null;
      return {
        sourceId: id,
        targetGapId,
        decision,
        matchedAlias: decision?.matchedAlias || null,
        rejectionStage: 'pre-read',
      };
    }),
  };
}

export async function resolveRecoveryAction(state, {
  llm,
  gate,
  signal,
  queryMemory,
  embedding,
  maxQueriesPerStep = 3,
  gapId = null,
  rejectedQueries = [],
  search = null,
} = {}) {
  const repair = nextSlotRepairAction(state, { readiness: gate, maxQueries: maxQueriesPerStep });
  let gap = state.getGap(repair?.gapId || gapId || state.focusGap()?.id);
  if (repair?.action === 'read') return repair;
  if (!gap || isRepairTerminal(gap)) return null;
  const filter = (queries) => filterDuplicateQueries(queries, {
    state,
    queryMemory,
    gapId: gap.id,
    embedding,
    signal,
  });
  const unread = state.pickPolicyReads?.(2, gap.id) || [];
  if (unread.length) {
    return {
      action: 'read',
      sourceIds: unread.map((candidate) => candidate.id),
      gapId: gap.id,
      reasonCode: 'fallback_read_evidence',
    };
  }
  const recoveryHosts = listNotRetrievedLiteralRequiredHosts({
    gap,
    findings: state.findings,
    query: state.query,
    brief: state.brief,
  });
  const recoveryMode = recoveryHosts.length ? 'required_host_recovery' : 'recovery';
  const plan = await planSearchQueries({
    ...plannerContext(state, { llm, signal, queryMemory, gate, rejectedQueries, search, gap }),
    mode: recoveryMode,
    recoveryHosts,
    gap,
    gapId: gap.id,
    limit: recoveryHosts.length
      ? Math.min(maxQueriesPerStep, recoveryHosts.length)
      : maxQueriesPerStep,
  });
  recordPlannerMetrics(state, plan, { gapId: gap.id, stage: recoveryMode });
  const plannedQueries = plan.ok ? await filter(plan.queries) : [];
  if (plannedQueries.length) {
    return {
      action: 'search',
      query: plannedQueries[0],
      queries: plannedQueries,
      gapId: gap.id,
      queryOrigin: 'llm_planner',
      plannerMode: recoveryMode,
      plannedQueries: plan.planned,
      reasonCode: recoveryHosts.length ? 'required_host_recovery' : 'fresh_query_recovery',
      repairTarget: gap.id,
    };
  }
  const userQuery = String(state.query || '').trim();
  const unusedUser = userQuery ? await filter([userQuery]) : [];
  if (unusedUser.length) {
    return {
      action: 'search',
      query: unusedUser[0],
      queries: unusedUser,
      gapId: gap.id,
      queryOrigin: 'user_query',
      reasonCode: 'fresh_query_recovery',
      repairTarget: gap.id,
    };
  }
  return null;
}

export function applyGapRerankDecision(candidate, gap, item, result, relevance, state) {
  const scopedRerank = { score: item.score, provider: result.provider, degraded: result.degraded };
  const match = candidate.gapMatches?.[gap.id] || { queries: [] };
  const scoped = {
    ...candidate,
    gapId: gap.id,
    tier: match.tier || candidate.tier,
    rerank: scopedRerank,
    rerankScore: item.score,
  };
  const decision = {
    ...evaluateSourceRelevance(scoped, {
      ...relevance,
      gap,
      query: gap.question || state.query,
      entities: state.brief?.entities || state.profile?.brief?.entities || [],
      entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
      rerankProvider: result.provider,
    }),
    gapId: gap.id,
  };
  candidate.gapMatches = {
    ...(candidate.gapMatches || {}),
    [gap.id]: {
      ...match,
      rerank: scopedRerank,
      rerankScore: item.score,
      relevanceDecision: decision,
    },
  };
  candidate.relevanceDecisionByGap = {
    ...(candidate.relevanceDecisionByGap || {}),
    [gap.id]: decision,
  };
  if (candidate.gapId === gap.id) {
    candidate.rerank = scopedRerank;
    candidate.rerankScore = item.score;
    candidate.relevanceDecision = decision;
  }
  return decision;
}

export async function observeRerank({ state, gap, providers, signal, trace, budget, relevance = {} }) {
  if (!providers?.rerank) return null;
  const unread = [...state.candidates.values()].filter((source) => (
    (source.gapId === gap.id || source.gapIds?.includes(gap.id))
    && !state.readSourceIds.has(source.id)
    && source.status !== 'read'
    && source.status !== 'failed'
    && source.status !== 'waf'
    && source.status !== 'irrelevant'
    && source.status !== 'duplicate'
  ));
  if (!unread.length) return null;
  const model = providers.rerank.model || null;
  const pending = [];
  let cacheHits = 0;
  for (const source of unread) {
    const fingerprint = candidateContentFingerprint(source);
    const key = rerankEvaluationKey(gap.id, source.id, fingerprint, model);
    const cached = state.rerankCache.get(key);
    if (cached) {
      cacheHits += 1;
      applyGapRerankDecision(source, gap, cached.item, cached.result, relevance, state);
      continue;
    }
    pending.push({ source, fingerprint, key });
  }
  state.relevance.cacheHits += cacheHits;
  const query = gap.question || state.query;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let missingResults = 0;
  let result = { items: [], provider: providers.rerank.id || 'rerank', model, degraded: false, durationMs: 0 };
  const startedAt = Date.now();
  if (pending.length) {
    const documents = pending.map(({ source }) => ({
      id: source.id,
      text: [source.title, source.snippet, source.summary, source.content].filter(Boolean).join('\n'),
    }));
    result = await providers.rerank.rerank({ query, documents, signal });
    state.relevance.rerankCalls += 1;
    state.relevance.uniqueGapCandidateEvaluations += pending.length;
    const decidedIds = new Set();
    for (const item of result.items) {
      const pendingItem = pending.find((entry) => entry.source.id === item.id);
      const candidate = state.candidates.get(item.id);
      if (!candidate || !pendingItem) continue;
      const decision = applyGapRerankDecision(candidate, gap, item, result, relevance, state);
      state.rerankCache.set(pendingItem.key, {
        item,
        result: { provider: result.provider, model: result.model || model, degraded: result.degraded },
      });
      decidedIds.add(item.id);
      if (decision.accepted) {
        acceptedCount += 1;
        if (decision.lowRerank) {
          state.relevance.rerankLowScore = (state.relevance.rerankLowScore || 0) + 1;
        }
      } else {
        rejectedCount += 1;
      }
    }
    for (const entry of pending) {
      if (!decidedIds.has(entry.source.id)) missingResults += 1;
    }
  }
  state.relevance.rerankEvaluated += acceptedCount + rejectedCount;
  state.relevance.rerankAccepted += acceptedCount;
  state.relevance.rerankRejected += rejectedCount;
  state.relevance.rerankMissingResults = (state.relevance.rerankMissingResults || 0) + missingResults;
  const traceRecord = {
    query,
    model: result.model || model,
    provider: result.provider,
    inputCount: unread.length,
    cacheHits,
    uniqueEvaluations: pending.length,
    durationMs: result.durationMs || (Date.now() - startedAt),
    degraded: Boolean(result.degraded),
    selectedReason: 'current_gap_unread',
    threshold: relevance.minRerankScore ?? null,
    acceptedCount,
    rejectedCount,
    missingResults,
  };
  addTrace(trace, state, 'rerank', {
    reasonCode: result.degraded ? 'rerank_degraded' : 'rerank_completed',
    ...traceRecord,
  }, budget, result.degraded ? 'degraded' : 'success');
  return traceRecord;
}
