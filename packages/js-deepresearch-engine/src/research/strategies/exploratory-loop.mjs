import { enrichFindings } from '../source-enricher.mjs';
import { resolveReadSettings } from '../read-settings.mjs';
import { applyExploratoryBudget, effectiveExploratoryMaxSteps, resolveExploratorySettings } from '../exploratory-settings.mjs';
import { decideAdaptiveAction, fallbackAdaptiveAction, evaluateAnswerReadiness, decomposeQuery, pickUnreadCandidates, belowHardCapFrom } from '../adaptive/agent-policy.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';
import { classifyResearchQuery } from '../adaptive/exploratory-sufficiency.mjs';
import { inferResearchProfile } from '../adaptive/research-profile.mjs';
import { applyContractGaps, planAndNormalizeContract } from '../research-contract.mjs';
import { applySlotSupportJudgments, judgeOpenSlotSupport } from '../gap-slot-support.mjs';
import { mergeResearchBrief, researchBriefFromInput } from '../research-brief.mjs';
import { classifyFetchedBody, sanitizeUnusableSourceBody } from '../body-quality.mjs';
import {
  evaluateSourceRelevance,
  inferEvidenceScope,
  listLocalCorpusChannels,
  siteHostsFromQuery,
  sourceMatchesSiteQuery,
  classifySourceTier,
} from '../adaptive/source-policy.mjs';
import {
  markRepairAngleExhausted,
  nextSlotRepairAction,
} from '../adaptive/slot-repair-scheduler.mjs';
import { attachPlannedQueries, planSearchQueries } from '../search-query-planner.mjs';
import { plannerFeedbackFromState } from '../planner-feedback.mjs';
import { buildExecutedSearchTrace } from '../search-trace.mjs';
import { getSearchMeta } from '../../search/search-result.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveSearchConcurrency } from '../../search/search-capabilities.mjs';
import {
  classifyInvalidReason,
  classifySearchProgress,
  isTransientSearchError,
} from '../../search/search-provider-error.mjs';
import { promoteSuccessfulSources } from '../slot-promotion.mjs';
import { candidateContentFingerprint, rerankEvaluationKey } from '../adaptive/research-state.mjs';
import { collectObservabilityMetrics } from '../observability.mjs';
import { normalizeQuery, querySimilarity } from '../query-memory.mjs';
import {
  EXPLORATORY_STOP_REASONS,
  mapFinalizeStopReason,
  resolveNewRunStopReason,
} from '../adaptive/stop-reasons.mjs';
import {
  clusterUrlRecords,
  readAddsNovelty,
} from '../adaptive/embedding-signals.mjs';

const STOP_REASONS = {
  evidenceSufficient: EXPLORATORY_STOP_REASONS.evidenceSufficient,
  budgetExhausted: EXPLORATORY_STOP_REASONS.budgetExhausted,
  safetyCap: EXPLORATORY_STOP_REASONS.safetyCap,
  userCancelled: EXPLORATORY_STOP_REASONS.userCancelled,
  contractUnavailable: EXPLORATORY_STOP_REASONS.contractUnavailable,
};

const FINALIZE_ACTIONS = new Set(['answer', 'finalize', 'stop', 'draft']);

function abort(signal) {
  signal?.throwIfAborted?.();
}

function addTrace(trace, state, action, fields, budget, status = 'success') {
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

function loopCanAfford(budget, tokens) {
  if (!budget || !budget.limits?.llmTokens) return true;
  return budget.canClaim('llmTokens', Math.max(1, Number(tokens) || 1));
}

function hasStepCap(maxSteps) {
  return Number(maxSteps) > 0;
}

function dynamicGapCount(state) {
  return state.gaps.filter((gap) => !gap.rollup && !gap.requiredSlot).length;
}

function countCapsExhausted(budget) {
  return Boolean(budget?.exhaustionDetail?.({ llmClaim: 0 }));
}

function attachLoopMeta(findings, meta) {
  Object.defineProperty(findings, 'exploratoryLoop', {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return findings;
}

function selectedFinding(state, sourceIds, gapId) {
  const sources = sourceIds.map((id) => state.candidates.get(id)).filter(Boolean);
  const gap = state.gaps.find((item) => item.id === gapId) || state.gaps[0];
  return { question: gap.question, gapId: gap.id, sources };
}

function addSerpKnowledge(state, results, gapId) {
  const top = (results || []).slice(0, 3)
    .map((result) => [result.title, result.snippet].filter(Boolean).join(': '))
    .filter(Boolean);
  if (!top.length) return;
  state.addKnowledge({ gapId, sourceId: null, learned: `SERP: ${top.join(' | ')}` });
}

function normalizeSearchQueries(action, maxQueries, { evidenceScope } = {}) {
  const queries = Array.isArray(action.queries) ? action.queries : [];
  const merged = [String(action.query || '').trim(), ...queries.map((query) => String(query || '').trim())];
  const unique = [...new Set(merged.filter(Boolean))];
  const scoped = evidenceScope === 'local'
    ? unique.filter((query) => !/\bsite:\s*\S+/i.test(query))
    : unique;
  return scoped.slice(0, maxQueries);
}

function plannerContext(state, {
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
  };
}

function recordPlannerMetrics(state, plan, extra = {}) {
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

async function filterDuplicateQueries(queries, { state, queryMemory, gapId, embedding, signal }) {
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
  for (const rejection of result.rejected) {
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

function contractRepairTargets(state, gate) {
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

function unresolvedRepairGaps(state, gate) {
  return contractRepairTargets(state, gate);
}

function hasEligibleUnread(state, gaps = []) {
  return gaps.some((gap) => (state.pickPolicyReads?.(2, gap.id) || []).length > 0);
}

function allUnresolvedBlocked(state, gate) {
  const targets = contractRepairTargets(state, gate);
  if (!targets.length) return false;
  if (!targets.every((gap) => gap.status === 'blocked')) return false;
  return !hasEligibleUnread(state, targets);
}

function safetyStopDetail(state, { trigger } = {}) {
  if (trigger === 'consecutive_invalid') return 'consecutive_invalid_steps';
  if (trigger === 'all_unresolved_blocked') {
    const last = state.recovery.lastPlannerFailure;
    const lastReason = typeof last === 'object' ? last.reason : last;
    if (last && typeof last === 'object' && last.step === state.step && last.gapId) {
      const remaining = contractRepairTargets(state, state.readiness);
      if (remaining.some((gap) => gap.id === last.gapId && gap.status === 'blocked') && lastReason) {
        return 'query_planner_exhausted';
      }
    }
    return 'repair_exhausted';
  }
  return 'repair_exhausted';
}

function readRejectionTrace(state, action, invalid) {
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
  if (!gap || gap.status === 'blocked') return null;
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
  const plan = await planSearchQueries({
    ...plannerContext(state, { llm, signal, queryMemory, gate, rejectedQueries, search, gap }),
    mode: 'recovery',
    gap,
    gapId: gap.id,
    limit: maxQueriesPerStep,
  });
  recordPlannerMetrics(state, plan, { gapId: gap.id, stage: 'recovery' });
  const plannedQueries = plan.ok ? await filter(plan.queries) : [];
  if (plannedQueries.length) {
    return {
      action: 'search',
      query: plannedQueries[0],
      queries: plannedQueries,
      gapId: gap.id,
      queryOrigin: 'llm_planner',
      plannerMode: 'recovery',
      plannedQueries: plan.planned,
      reasonCode: 'fresh_query_recovery',
      repairTarget: gap.id,
    };
  }
  if (!plan.ok) state.setPlannerFailure(plan.failure, { gapId: gap.id, stage: 'recovery' });
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

function applyGapRerankDecision(candidate, gap, item, result, relevance, state) {
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

async function observeRerank({ state, gap, providers, signal, trace, budget, relevance = {} }) {
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
      if (decision.accepted) acceptedCount += 1;
      else rejectedCount += 1;
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

export async function runExploratoryLoop(context) {
  const { query, llm, search, signal, emit, settings, budget, queryMemory, trace, researchProviders } = context;
  const exploratory = resolveExploratorySettings(settings);
  const readPolicy = resolveReadSettings(settings, { strategy: 'exploratory' });
  const queryShape = classifyResearchQuery(query);
  applyExploratoryBudget(budget, exploratory);
  const maxSteps = effectiveExploratoryMaxSteps(exploratory, budget?.limits?.llmTokens);
  const evidenceScope = inferEvidenceScope(settings);
  const incomingBrief = context.brief || researchBriefFromInput(query, { depth: 'exploratory' });
  let profile = inferResearchProfile({ ...incomingBrief, query }, { settings, evidenceScope, depth: 'exploratory' });
  profile.brief = mergeResearchBrief(incomingBrief, profile.brief, { query, depth: 'exploratory' });
  const state = new ResearchState({
    query,
    maxSteps,
    maxGapDepth: exploratory.maxGapDepth,
    minLlmTokens: exploratory.minLlmTokens,
    targetLlmTokens: exploratory.minLlmTokens,
    budget,
    profile,
    settings,
    evidenceScope,
    brief: profile.brief,
  });
  const maxReads = Math.max(1, Number(exploratory.maxReadsPerStep) || 3);
  const maxRetries = Math.max(0, Number(exploratory.maxEvaluationRetries) || 0);
  const maxOpenGaps = Number(exploratory.maxOpenGaps) || 8;
  const maxQueriesPerStep = Math.max(1, Number(exploratory.maxQueriesPerStep) || 3);
  const autoReadTopK = Math.min(Math.max(0, Number(exploratory.autoReadTopK ?? 0)), maxReads);
  const answerGateEnabled = exploratory.answerGate !== false;
  const gateMode = exploratory.gateMode || 'rules-then-llm';
  const embedding = researchProviders?.embedding || null;
  if (embedding && queryMemory) {
    queryMemory.similarityProvider = embedding;
    queryMemory.semanticDedup = true;
  }
  let degraded = false;
  let stopReason = null;
  let stopDetail = null;
  let stopRequiredAmount = null;
  let pendingStopReason = null;
  let consecutiveInvalidSteps = 0;

  emit({ stage: 'assessing_query', step: 0, maxSteps: state.maxSteps });
  emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
  addTrace(trace, state, 'assess', {
    reasonCode: 'exploratory_loop',
    targetGapIds: ['gap-1'],
    profile: {
      flags: profile.flags,
      requiredHosts: profile.requiredHosts,
      method: profile.method,
      evidenceScope,
      corpusChannelCount: listLocalCorpusChannels(settings).length,
    },
  }, budget);

  function refreshState() {
    state.refreshBudgetView({
      budget,
      minLlmTokens: exploratory.minLlmTokens,
      actionCosts: state.actionCosts,
    });
    return state.readiness;
  }

  function canContinueLoop() {
    return (!hasStepCap(state.maxSteps) || state.step < state.maxSteps)
      && loopCanAfford(budget, state.actionCosts.estimate('search'))
      && !state.budgetView?.hardCapReached
      && !countCapsExhausted(budget);
  }

  async function performRead({ sourceIds, gapId, reasonCode, harvest = false }) {
    const tokensBefore = budget?.usage?.llmTokens || 0;
    emit({
      stage: 'enriching_sources',
      step: Math.max(1, state.step),
      maxSteps: state.maxSteps,
      total: sourceIds.length,
    });
    const targetGap = state.getGap(gapId);
    let finding = selectedFinding(state, sourceIds, gapId);
    finding = (await enrichFindings([finding], {
      query,
      fetchMode: readPolicy.fetchMode,
      maxUrlsPerIteration: maxReads,
      maxUrlsTotal: maxReads,
      maxContentChars: readPolicy.maxContentChars,
      enrichConcurrency: readPolicy.enrichConcurrency,
      llm,
      signal,
      settings,
      budget,
      embedding,
      relevance: readPolicy.relevance,
      relevanceGap: targetGap,
      entities: state.brief?.entities || state.profile?.brief?.entities || [],
      entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
      observedHosts: [...(state.observedHosts || [])],
    }))[0];
    const classifiedSources = [];
    let successful = 0;
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      let quality = classifyFetchedBody(source);
      const candidate = state.candidates.get(id) || {};
      const gapDecision = candidate.gapMatches?.[targetGap?.id]?.relevanceDecision
        || candidate.relevanceDecisionByGap?.[targetGap?.id]
        || source.relevanceDecision
        || null;
      let bodyRelevance = gapDecision ? { ...gapDecision, gapId: targetGap?.id || finding.gapId } : null;
      if (quality.successful && readPolicy.relevance.bodyValidation) {
        bodyRelevance = {
          ...evaluateSourceRelevance(source, {
          ...readPolicy.relevance,
          gap: targetGap,
          query: targetGap?.question || query,
          entities: state.brief?.entities || state.profile?.brief?.entities || [],
          entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
          enforceEntity: readPolicy.relevance.entityGuard !== false,
          rerankProvider: 'disabled',
          allowRequiredHostProbe: false,
          }),
          gapId: targetGap?.id || finding.gapId,
        };
        if (!bodyRelevance.accepted) {
          quality = {
            status: 'irrelevant',
            successful: false,
            reason: bodyRelevance.reasonCode,
          };
        }
      }
      const next = sanitizeUnusableSourceBody({
        ...source,
        id,
        bodyQuality: quality.status,
        fetchStatus: quality.status === 'waf' ? 'waf' : source.fetchStatus,
        tier: classifySourceTier(source, targetGap),
        assessment: source.assessment || null,
        relevanceDecision: bodyRelevance,
        relevanceDecisionByGap: {
          ...(source.relevanceDecisionByGap || candidate.relevanceDecisionByGap || {}),
          [targetGap?.id || finding.gapId]: bodyRelevance,
        },
      }, quality);
      classifiedSources.push(next);
      state.readSourceIds.add(id);
      const existing = state.candidates.get(id) || {};
      const existingMatch = existing.gapMatches?.[targetGap?.id] || {};
      state.candidates.set(id, { ...existing, ...next, id, freq: existing.freq || 1 });
      const stored = state.candidates.get(id);
      stored.gapMatches = {
        ...(stored.gapMatches || {}),
        [targetGap?.id || finding.gapId]: {
          ...existingMatch,
          relevanceDecision: bodyRelevance,
        },
      };
      state.markCandidateStatus(id, quality.status, quality.reason);
      if (quality.successful) {
        successful += 1;
        state.relevance.readAccepted += 1;
        state.noteSuccessfulBody();
        state.addKnowledge({ gapId: finding.gapId, sourceId: id, learned: next.summary || next.content || next.snippet });
        const known = state.knowledge
          .filter((item) => item.gapId === finding.gapId && item.sourceId)
          .map((item) => item.learned);
        const novelty = await readAddsNovelty({
          embedding,
          newText: next.summary || next.content || '',
          knownTexts: known.slice(0, -1),
          signal,
          traces: state.embeddingTraces,
        });
        next.novelty = novelty.novel;
        state.noteReadNovelty(novelty.novel);
      } else if (quality.status === 'irrelevant') {
        state.relevance.bodyIrrelevant += 1;
      }
      const gap = state.getGap(finding.gapId);
      if (gap && !gap.readSourceIds.includes(id)) gap.readSourceIds.push(id);
    }
    finding.sources = classifiedSources;
    state.findings.push(finding);
    const promotions = promoteSuccessfulSources({
      state,
      sources: classifiedSources,
      discoveryGapId: finding.gapId,
      entities: state.brief?.entities || state.profile?.brief?.entities || [],
      entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
    });
    if (promotions.length) {
      state.noteProgressKind('progress');
      for (const item of promotions) state.clearPlannerFailure({ gapId: item.targetGapId });
      addTrace(trace, state, 'slot_promotion', {
        reasonCode: 'cross_slot_promotion',
        promotions,
        targetGapIds: promotions.map((item) => item.targetGapId),
      }, budget);
    }
    const readHostnames = classifiedSources.map((source) => source.hostname).filter(Boolean);
    state.observations.push({
      type: 'read_result',
      sourceIds,
      successful,
      harvest,
      waf: classifiedSources.filter((source) => source.bodyQuality === 'waf').length,
    });
    state.addDiary(`${harvest ? 'auto-harvested' : 'read'} ${sourceIds.length} source(s) (${readHostnames.join(', ') || 'unknown hosts'}) for ${finding.gapId}; ${successful} successful bodies`);
    state.actionCosts.record('read', (budget?.usage?.llmTokens || 0) - tokensBefore);
    state.syncGapCoverage();
    if (successful > 0) {
      const support = await judgeOpenSlotSupport({
        llm,
        signal,
        query,
        gaps: state.gaps,
        findings: state.findings,
        cache: state.slotSupportCache,
      });
      applySlotSupportJudgments(state.gaps, support.judgments);
      state.syncGapCoverage();
      if (support.judgments.some((item) => ['supported', 'partially_supported'].includes(item.verdict))) {
        consecutiveInvalidSteps = 0;
        state.noteProgressKind('progress');
      }
      addTrace(trace, state, 'slot_support', {
        reasonCode: support.unknown ? 'slot_support_unknown' : 'slot_support_judged',
        unknown: support.unknown,
        retried: support.retried,
        attempts: support.attempts,
        batches: support.batches,
        splitRetries: support.splitRetries,
        cacheHits: support.cacheHits,
        cacheMisses: support.cacheMisses,
        gapIds: support.judgments.map((item) => item.gapId).filter(Boolean),
      }, budget, support.unknown ? 'degraded' : 'success');
    }
    addTrace(trace, state, 'read', {
      reasonCode,
      targetGapIds: [finding.gapId],
      sourceIds,
      knowledgeCount: state.knowledge.length,
      harvest,
      decisionStep: !harvest,
      successfulBodies: successful,
      reads: classifiedSources.map((source) => ({
        sourceId: source.id || source.url,
        targetGapId: finding.gapId,
        discoveryGapIds: state.candidates.get(source.id || source.url)?.gapIds || [finding.gapId],
        query: state.candidates.get(source.id || source.url)?.gapMatches?.[finding.gapId]?.queries?.[0] || null,
        decision: source.relevanceDecision || null,
        matchedAlias: source.relevanceDecision?.matchedAlias || null,
        rejectionStage: source.relevanceDecision && source.relevanceDecision.accepted === false
          ? (source.bodyQuality === 'irrelevant' ? 'body' : 'pre-read')
          : null,
        selectReason: reasonCode,
      })),
    }, budget);
    return successful;
  }

  const profileTokensBefore = budget?.usage?.llmTokens || 0;
  const contract = await planAndNormalizeContract({
    llm,
    query,
    incomingBrief,
    settings,
    signal,
    evidenceScope,
    depth: 'exploratory',
  });
  profile = contract.profile;
  state.profile = profile;
  state.brief = contract.brief;
  state.evidenceScope = profile.evidenceScope || evidenceScope;
  applyContractGaps(state, contract, { maxGaps: maxOpenGaps });
  addTrace(trace, state, 'research_brief_sanitized', {
    reasonCode: contract.contractUnavailable ? 'contract_unavailable' : 'planner_output_validated',
    brief: state.brief,
    contractOrigin: state.brief?.contractOrigin,
    contractRetried: contract.contractRetried,
    contractFailure: contract.contractFailure,
  }, budget);
  state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - profileTokensBefore);

  if (contract.contractUnavailable) {
    stopReason = STOP_REASONS.safetyCap;
    stopDetail = 'contract_unavailable';
    addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.contractUnavailable }, budget, 'failed');
    budget?.setControllerStopReason?.(stopReason, stopDetail);
    refreshState();
    emit({
      stage: 'research_stopped',
      reason: stopReason,
      step: state.step,
      maxSteps: state.maxSteps,
    });
    return attachLoopMeta(state.findings, {
      stopReason,
      stopDetail,
      profile: state.profile,
      brief: state.brief,
      gaps: state.gaps,
      readiness: state.readiness,
      embeddingTraces: state.embeddingTraces,
      marginal: state.snapshot().marginal,
      relevance: state.snapshot().relevance,
      recovery: state.snapshot().recovery,
      ...state.unresolvedReportNotes(),
    });
  }

  if (queryShape.kind === 'definitional' || contract.slots.length) {
    addTrace(trace, state, 'decompose', {
      reasonCode: contract.slots.length ? 'decompose_skipped_slots' : 'decompose_skipped_definitional',
      targetGapIds: state.gaps.map((gap) => gap.id),
      subQuestionCount: 0,
    }, budget, 'skipped');
  } else {
    const tokensBefore = budget?.usage?.llmTokens || 0;
    const planned = (profile.plannedGaps || []).map((item) => item.question).filter(Boolean);
    const subQuestions = planned.length
      ? planned
      : await decomposeQuery({ llm, state, signal });
    state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
    for (const question of subQuestions) {
      if (dynamicGapCount(state) >= maxOpenGaps) break;
      const plannedGap = (profile.plannedGaps || []).find((item) => item.question === question);
      const gap = state.addGap(question, plannedGap?.priority || 'normal', {
        requiredHosts: plannedGap?.requiredHosts,
      });
      if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
    }
    addTrace(trace, state, 'decompose', {
      reasonCode: subQuestions.length ? 'query_decomposed' : 'decompose_skipped',
      targetGapIds: state.gaps.map((gap) => gap.id),
      subQuestionCount: subQuestions.length,
    }, budget, subQuestions.length ? 'success' : 'skipped');
  }

  try {
    while (!hasStepCap(state.maxSteps) || state.step < state.maxSteps) {
      abort(signal);
      const gate = refreshState();

      if (budget && !loopCanAfford(budget, state.actionCosts.estimate('decide'))) {
        stopReason = STOP_REASONS.budgetExhausted;
        stopRequiredAmount = state.actionCosts.estimate('decide');
        stopDetail = budget.exhaustionDetail?.({ llmClaim: stopRequiredAmount }) || 'llm_hard_cap';
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, stopDetail }, budget, 'budget_exhausted');
        break;
      }

      const belowMin = Boolean(state.budgetView?.belowMin);
      const belowHardCap = belowHardCapFrom(state);
      let action;
      if (state.budgetView?.hardCapReached) {
        stopReason = STOP_REASONS.budgetExhausted;
        stopDetail = budget?.exhaustionDetail?.({ llmClaim: 1 }) || 'llm_hard_cap';
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, stopDetail }, budget, 'budget_exhausted');
        break;
      } else if (countCapsExhausted(budget)) {
        action = { action: 'answer', reasonCode: STOP_REASONS.budgetExhausted };
        stopDetail = budget.exhaustionDetail?.({ llmClaim: 0 });
        pendingStopReason = STOP_REASONS.budgetExhausted;
        degraded = true;
      } else if (gate?.pass && !belowMin) {
        action = { action: 'answer', reasonCode: 'evidence_sufficient' };
      } else {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        action = await decideAdaptiveAction({ llm, state, signal });
        state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
        if (
          !action
          || (
            FINALIZE_ACTIONS.has(action.action)
            && (belowMin || state.forbidFinalizeUntilExplore)
            && pendingStopReason !== STOP_REASONS.budgetExhausted
            && pendingStopReason !== STOP_REASONS.safetyCap
          )
        ) {
          action = fallbackAdaptiveAction(state, {
            belowMin,
            belowHardCap,
            readiness: gate,
            sufficiency: state.sufficiency,
          });
        }
        if (state.marginal.plateau && action?.action === 'search') {
          action = {
            ...action,
            plannerMode: 'angle_change',
            needsPlanner: action.queryOrigin !== 'user_query',
            reasonCode: 'plateau_change_angle',
          };
          addTrace(trace, state, 'plateau', {
            reasonCode: 'exploratory_action_redirected',
            marginal: { ...state.marginal },
            originalAction: 'search',
            nextAction: action.action,
          }, budget);
        }
        if (FINALIZE_ACTIONS.has(action?.action) && !gate?.pass && pendingStopReason !== STOP_REASONS.budgetExhausted) {
          action = {
            ...action,
            blockedByGate: true,
          };
        }
      }

      if (action?.action === 'search'
        && state.getGap(action.gapId)?.rollup
        && !gate?.pass
        && pendingStopReason !== STOP_REASONS.budgetExhausted) {
        const repair = nextSlotRepairAction(state, { readiness: gate });
        if (repair?.gapId && state.getGap(repair.gapId)?.requiredSlot) {
          const originalAction = action;
          action = repair.action === 'search' ? {
            ...action,
            gapId: repair.gapId,
            plannerMode: action.plannerMode || repair.plannerMode || 'repair',
            needsPlanner: action.queryOrigin !== 'user_query',
            reasonCode: action.reasonCode || repair.reasonCode,
            repairTarget: repair.gapId,
          } : { ...repair, repairTarget: repair.gapId };
          addTrace(trace, state, 'search_redirect', {
            reasonCode: 'rollup_to_required_slot',
            targetGapIds: [repair.gapId],
            originalAction: originalAction.action,
            nextAction: action.action,
          }, budget);
        }
      }
      if (action?.action === 'read' && state.getGap(action.gapId)?.rollup && !gate?.pass
        && pendingStopReason !== STOP_REASONS.budgetExhausted) {
        const sourceGapId = action.sourceIds
          ?.map((id) => state.candidates.get(id)?.gapId)
          .find((gapId) => gapId && !state.getGap(gapId)?.rollup);
        const repair = sourceGapId
          ? { gapId: sourceGapId }
          : nextSlotRepairAction(state, { readiness: gate, maxQueries: maxQueriesPerStep });
        if (repair?.gapId && (sourceGapId || state.getGap(repair.gapId)?.requiredSlot)) {
          action = { ...action, gapId: repair.gapId, repairTarget: repair.gapId };
          addTrace(trace, state, 'read_redirect', {
            reasonCode: 'rollup_to_required_slot',
            targetGapIds: [repair.gapId],
          }, budget);
        }
      }

      if (
        action?.action === 'search'
        && action.queryOrigin !== 'user_query'
        && pendingStopReason !== STOP_REASONS.budgetExhausted
      ) {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        const planned = await attachPlannedQueries(action, {
          ...plannerContext(state, {
            llm,
            signal,
            queryMemory,
            gate,
            search,
            gap: state.getGap(action.gapId || state.focusGap()?.id),
          }),
          mode: action.plannerMode || (state.marginal.plateau ? 'angle_change' : 'repair'),
          gap: state.getGap(action.gapId || state.focusGap()?.id),
          gapId: action.gapId || state.focusGap()?.id,
          limit: maxQueriesPerStep,
        });
        state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
        recordPlannerMetrics(state, planned.plan, {
          gapId: planned.action?.gapId || action.gapId,
          stage: planned.action?.plannerMode || action.plannerMode || 'repair',
        });
        addTrace(trace, state, 'search_query_planned', {
          reasonCode: planned.plan?.reasonCode || planned.action?.planFailure || 'search_query_failed',
          plannerMode: planned.action?.plannerMode || action.plannerMode,
          queryOrigin: planned.action?.queryOrigin || null,
          queries: planned.action?.queries || [],
          failure: planned.plan?.failure || planned.action?.planFailure || null,
          targetGapIds: [planned.action?.gapId || action.gapId].filter(Boolean),
        }, budget, planned.plan?.ok ? 'success' : 'failed');
        action = planned.action;
      }

      const queryScope = { evidenceScope: state.evidenceScope || evidenceScope };
      let invalid = pendingStopReason === STOP_REASONS.budgetExhausted ? null : state.validate(action);
      let searchQueries = [];
      if (!invalid && action.action === 'search') {
        const gap = state.getGap(action.gapId || state.focusGap()?.id);
        const rawQueries = normalizeSearchQueries(action, maxQueriesPerStep, queryScope);
        searchQueries = await filterDuplicateQueries(rawQueries.slice(0, maxQueriesPerStep), {
          state,
          queryMemory,
          gapId: gap.id,
          embedding,
          signal,
        });
        if (!searchQueries.length) invalid = 'duplicate_query';
      }
      if (invalid) {
        state.recovery.invalidSteps += 1;
        state.recovery.recoveryRounds += 1;
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        state.addDiary(`${action?.action || 'unknown'} rejected (${invalid})`);
        addTrace(trace, state, action?.action || 'unknown', action?.action === 'read'
          ? readRejectionTrace(state, action, invalid)
          : { reasonCode: invalid }, budget, 'rejected');
        if (classifyInvalidReason(invalid) === 'cap') {
          const resolvedStop = resolveNewRunStopReason(invalid, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          }) || STOP_REASONS.safetyCap;
          stopReason = resolvedStop;
          stopDetail = resolvedStop === STOP_REASONS.budgetExhausted
            ? budget?.exhaustionDetail?.({ llmClaim: 1 })
            : (resolvedStop === STOP_REASONS.safetyCap ? 'max_steps' : null);
          addTrace(trace, state, 'stop', { reasonCode: stopReason, stopDetail }, budget);
          break;
        }
        const requestedRecoveryGapId = action?.gapId || state.focusGap()?.id;
        const requestedRecoveryGap = state.getGap(requestedRecoveryGapId);
        const rotateRepair = ['duplicate', 'relevance_rejected'].includes(classifyInvalidReason(invalid))
          || requestedRecoveryGap?.rollup
          || requestedRecoveryGap?.status === 'blocked';
        const recoveryGapId = rotateRepair
          ? (nextSlotRepairAction(state, { readiness: gate, maxQueries: maxQueriesPerStep })?.gapId || requestedRecoveryGapId)
          : requestedRecoveryGapId;
        const tokensBefore = budget?.usage?.llmTokens || 0;
        action = belowHardCap && canContinueLoop()
          ? await resolveRecoveryAction(state, {
            llm,
            gate,
            signal,
            queryMemory,
            embedding,
            maxQueriesPerStep,
            gapId: recoveryGapId,
            rejectedQueries: [{ query: action?.query || '', reason: invalid }],
            search,
          })
          : null;
        state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
        invalid = action ? state.validate(action) : 'no_repair_action';
        if (!invalid && action.action === 'search') {
          searchQueries = normalizeSearchQueries(action, maxQueriesPerStep, queryScope);
          if (!searchQueries.length) invalid = 'duplicate_query';
        }
        if (invalid) {
          const kind = classifyInvalidReason(invalid);
          state.noteProgressKind(kind === 'semantic' ? 'semantic_no_yield' : kind);
          if (kind === 'semantic') consecutiveInvalidSteps += 1;
          const failedGap = state.getGap(recoveryGapId);
          if (kind === 'semantic' && failedGap && !failedGap.rollup && failedGap.status !== 'blocked') {
            failedGap.repairFailures = (Number(failedGap.repairFailures) || 0) + 1;
            if (failedGap.repairFailures >= exploratory.maxRepairFailuresPerGap) {
              const filteredAll = (failedGap.filteredQueries || []).some((item) => item.reason === 'site_filtered_all');
              const unreachableRequired = (failedGap.requiredHosts || []).length > 0;
              state.markGapStatus(
                failedGap.id,
                'blocked',
                filteredAll ? 'site_filtered_all' : (unreachableRequired ? 'required_host_unreachable' : 'repair_exhausted'),
              );
            }
          }
          const blockedAll = allUnresolvedBlocked(state, gate);
          const consecutiveCap = consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps;
          if (blockedAll || consecutiveCap) {
            stopReason = STOP_REASONS.safetyCap;
            stopDetail = safetyStopDetail(state, {
              trigger: consecutiveCap && !blockedAll ? 'consecutive_invalid' : 'all_unresolved_blocked',
            });
            addTrace(trace, state, 'stop', {
              reasonCode: stopReason,
              stopDetail,
              targetGapIds: unresolvedRepairGaps(state, gate).map((gap) => gap.id),
            }, budget);
            break;
          }
          const resolvedStop = resolveNewRunStopReason(pendingStopReason, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          });
          if (resolvedStop) {
            stopReason = resolvedStop;
            stopDetail = resolvedStop === STOP_REASONS.budgetExhausted
              ? budget?.exhaustionDetail?.({ llmClaim: 1 })
              : (resolvedStop === STOP_REASONS.safetyCap ? 'max_steps' : null);
            addTrace(trace, state, 'stop', { reasonCode: stopReason, stopDetail }, budget);
            break;
          }
          state.step += 1;
          state.observations.push({ type: 'recovery_advanced', reason: invalid });
          addTrace(trace, state, 'recovery', {
            reasonCode: invalid,
            recoveryState: 'advanced',
            targetGapIds: [state.focusGap()?.id].filter(Boolean),
          }, budget, 'retry');
          continue;
        }
      }
      const stepsRemaining = hasStepCap(state.maxSteps) ? state.maxSteps - state.step : null;
      if (stepsRemaining !== null && stepsRemaining <= 1 && !FINALIZE_ACTIONS.has(action.action)
        && (state.findings.length > 0 || state.candidates.size > 0)) {
        addTrace(trace, state, action.action, { reasonCode: 'forced_final_answer' }, budget, 'forced');
        state.forbidFinalizeUntilExplore = false;
        action = { action: 'answer', reasonCode: 'forced_final_answer' };
        pendingStopReason = STOP_REASONS.safetyCap;
      }
      state.step += 1;
      state.lastAction = action.action;
      abort(signal);

      if (action.action === 'search') {
        const gapId = action.gapId || state.focusGap()?.id || 'gap-1';
        const gap = state.getGap(gapId);
        state.forbidFinalizeUntilExplore = false;
        state.beginSearchCycle();
        const allowedQueries = [];
        for (const searchQuery of searchQueries) {
          if (allowedQueries.length === 0 || !budget || budget.canClaim('searchRequests', allowedQueries.length + 1)) {
            allowedQueries.push(searchQuery);
          }
        }
        emit({
          stage: 'searching',
          step: state.step,
          maxSteps: state.maxSteps,
          total: allowedQueries.length,
        });
        const candidatesBefore = state.candidates.size;
        const plannedByQuery = new Map((action.plannedQueries || []).map((item) => [item.query, item]));
        const concurrency = resolveSearchConcurrency(search, settings, 1);
        const executed = await searchQuestions({
          questions: allowedQueries.map((searchQuery) => ({
            question: searchQuery,
            searchOptions: plannedByQuery.get(searchQuery)?.searchOptions || null,
          })),
          search,
          signal,
          concurrency,
          gapId,
        });
        const searchResults = executed.map((item) => {
          const planned = plannedByQuery.get(item.searchQuery || item.question);
          return {
            searchQuery: item.searchQuery || item.question,
            results: item.sources || [],
            searchMeta: item.searchMeta,
            planned,
            searchOptions: item.searchOptions,
            queryOrigin: planned?.queryOrigin || action.queryOrigin || 'llm_planner',
            plannerMode: planned?.plannerMode || action.plannerMode || null,
            error: item.error || null,
            skipped: item.skipped || null,
          };
        });
        const fallbackQueries = new Set();
        for (const { searchQuery, results } of [...searchResults]) {
          state.observeHosts(results);
          const acceptedResults = readPolicy.relevance.siteConstraint
            ? results.filter((result) => sourceMatchesSiteQuery(result, searchQuery))
            : results;
          const rejectedForSite = results.length - acceptedResults.length;
          if (
            acceptedResults.length === 0
            && rejectedForSite > 0
            && siteHostsFromQuery(searchQuery).length > 0
            && searchResults.length < maxQueriesPerStep
            && (!budget || budget.canClaim('searchRequests'))
          ) {
            const tokensBefore = budget?.usage?.llmTokens || 0;
            const fallbackPlan = await planSearchQueries({
              ...plannerContext(state, {
                llm,
                signal,
                queryMemory,
                gate,
                search,
                gap,
                rejectedQueries: [{ query: searchQuery, reason: 'site_filtered_all' }],
                siteFallbackFor: searchQuery,
              }),
              mode: 'site_fallback',
              gap,
              gapId,
              limit: 1,
            });
            state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
            recordPlannerMetrics(state, fallbackPlan);
            const siteFree = fallbackPlan.queries[0] || '';
            const normalizedFallback = normalizeQuery(siteFree);
            const exactSeen = new Set([
              ...searchResults.map((item) => item.searchQuery),
              ...state.searchedQueries(),
              ...(gap.exhaustedAngles || []),
            ].map(normalizeQuery));
            if (fallbackPlan.ok && normalizedFallback && !exactSeen.has(normalizedFallback)) {
              abort(signal);
              const fallbackOptions = fallbackPlan.planned?.[0]?.searchOptions || null;
              try {
                const fallbackResults = await search.search(siteFree, { signal, searchOptions: fallbackOptions });
                searchResults.push({
                  searchQuery: siteFree,
                  results: Array.isArray(fallbackResults) ? fallbackResults : [],
                  searchMeta: getSearchMeta(fallbackResults),
                  planned: fallbackPlan.planned?.[0] || null,
                  searchOptions: fallbackOptions,
                  queryOrigin: 'llm_planner',
                  plannerMode: 'site_fallback',
                  siteFallbackOf: searchQuery,
                  error: null,
                });
                state.observeHosts(fallbackResults);
              } catch (error) {
                if (error?.name === 'AbortError') throw error;
                searchResults.push({
                  searchQuery: siteFree,
                  results: [],
                  searchMeta: null,
                  planned: fallbackPlan.planned?.[0] || null,
                  searchOptions: fallbackOptions,
                  queryOrigin: 'llm_planner',
                  plannerMode: 'site_fallback',
                  siteFallbackOf: searchQuery,
                  error,
                });
              }
              fallbackQueries.add(siteFree);
              state.recovery.siteFallbackQueries += 1;
              addTrace(trace, state, 'search', {
                reasonCode: 'site_fallback_query',
                query: siteFree,
                fallbackFor: searchQuery,
                siteFallbackOf: searchQuery,
                queryOrigin: 'llm_planner',
                plannerMode: 'site_fallback',
                plannedQueries: fallbackPlan.planned || null,
                searchOptions: fallbackOptions,
                targetGapIds: [gapId],
              }, budget);
            }
          }
        }
        let totalResults = 0;
        let returnedResults = 0;
        let siteRejectedResults = 0;
        let newUrls = 0;
        let duplicateSerp = false;
        let successfulAutoReads = 0;
        for (const item of searchResults) {
          const { searchQuery, results, searchMeta, searchOptions, planned, error } = item;
          returnedResults += results.length;
          const acceptedResults = readPolicy.relevance.siteConstraint
            ? results.filter((result) => sourceMatchesSiteQuery(result, searchQuery))
            : results;
          const rejectedForSite = results.length - acceptedResults.length;
          state.relevance.returnedCandidates += results.length;
          state.relevance.siteRejected += rejectedForSite;
          state.relevance.admittedCandidates += acceptedResults.length;
          totalResults += acceptedResults.length;
          siteRejectedResults += rejectedForSite;
          if (rejectedForSite > 0) {
            addTrace(trace, state, 'search_filter', {
              reasonCode: 'site_constraint_violation',
              query: searchQuery,
              targetGapIds: [gapId],
              rejectedCount: rejectedForSite,
              acceptedCount: acceptedResults.length,
            }, budget, 'filtered');
          }
          const memoryEntry = isTransientSearchError(error)
            ? null
            : queryMemory?.record?.({
              query: searchQuery,
              gapId,
              status: acceptedResults.length ? 'useful' : 'empty',
              results: acceptedResults,
            });
          if (memoryEntry?.status === 'duplicate_results') {
            duplicateSerp = true;
            state.addDiary(`duplicate results for "${searchQuery}"; skip equivalent searches`);
          }
          if (acceptedResults.length > 0) {
            state.recordSearchedQuery(gapId, searchQuery);
          } else if (isTransientSearchError(error)) {
            state.recordTransientSearch(error);
          } else {
            const reason = error ? 'failed' : (rejectedForSite > 0 ? 'site_filtered_all' : 'empty_results');
            state.recordFilteredQuery(gapId, searchQuery, reason);
          }
          const clustered = await clusterUrlRecords(acceptedResults.map((result) => ({
            ...result,
            hostname: result.hostname,
            registrableDomain: result.registrableDomain,
          })), { embedding, signal, traces: state.embeddingTraces });
          const clusterById = Object.fromEntries(clustered.map((item) => [item.id || item.url, item.clusterId]));
          const addedThisQuery = state.addCandidates(clustered, gapId, { query: searchQuery, clusterById });
          newUrls += addedThisQuery;
          state.noteSearchYield({
            duplicateResults: memoryEntry?.status === 'duplicate_results',
            newUrls: addedThisQuery,
          });
          addSerpKnowledge(state, acceptedResults, gapId);
          const outcome = state.recordSearchOutcome({
            query: searchQuery,
            queryOrigin: item.queryOrigin || action.queryOrigin || 'llm_planner',
            plannerMode: item.plannerMode || action.plannerMode || null,
            gapId,
            searchOptions,
            searchMeta,
            sources: acceptedResults,
            resultCount: acceptedResults.length,
            returnedResultCount: results.length,
            siteRejectedCount: rejectedForSite,
            newUrlCount: addedThisQuery,
            memoryStatus: memoryEntry?.status || null,
            error,
            skipped: memoryEntry?.status === 'duplicate_results' ? 'duplicate_results' : null,
          });
          state.observations.push({
            type: 'search_result',
            query: searchQuery,
            returnedResultCount: results.length,
            resultCount: acceptedResults.length,
            siteRejectedCount: rejectedForSite,
            newUrlCount: addedThisQuery,
            gapId,
            fallback: fallbackQueries.has(searchQuery),
            outcome: outcome.outcome,
          });
          addTrace(trace, state, 'search', buildExecutedSearchTrace({
            query: searchQuery,
            queryOrigin: item.queryOrigin || action.queryOrigin || 'llm_planner',
            plannerMode: item.plannerMode || action.plannerMode || null,
            plannedQueries: planned ? [planned] : (action.plannedQueries || null),
            searchOptions,
            sources: acceptedResults,
            searchMeta,
            resultCount: acceptedResults.length,
            returnedResultCount: results.length,
            siteRejectedCount: rejectedForSite,
            newUrlCount: addedThisQuery,
            memoryStatus: memoryEntry?.status || null,
            error,
            skipped: memoryEntry?.status === 'duplicate_results' ? 'duplicate_results' : null,
            targetGapIds: [gapId],
            reasonCode: isTransientSearchError(error)
              ? (error.code === 'rate_limited' ? 'rate_limited' : 'provider_error')
              : (error
                ? 'search_failed'
                : (memoryEntry?.status === 'duplicate_results'
                  ? 'duplicate_results'
                  : (acceptedResults.length > 0 ? 'executed_search' : (rejectedForSite > 0 ? 'site_filtered_all' : 'empty_results')))),
            siteFallbackOf: item.siteFallbackOf || null,
          }), budget, error ? 'failed' : (memoryEntry?.status === 'duplicate_results' ? 'skipped' : (acceptedResults.length ? 'success' : 'filtered')));
        }
        await observeRerank({
          state,
          gap,
          providers: researchProviders,
          signal,
          trace,
          budget,
          relevance: readPolicy.relevance,
        });
        state.addDiary(`searched ${searchResults.length} quer${searchResults.length === 1 ? 'y' : 'ies'}, +${state.candidates.size - candidatesBefore} candidates`);
        addTrace(trace, state, 'search', {
          reasonCode: action.reasonCode || 'agent_search',
          targetGapIds: [gapId],
          query: allowedQueries[0] || action.query || null,
          queries: allowedQueries,
          queryOrigin: action.queryOrigin || (action.query === state.query ? 'user_query' : 'llm_planner'),
          plannerMode: action.plannerMode || null,
          plannedQueries: action.plannedQueries || null,
          queryCount: searchResults.length,
          resultCount: totalResults,
          returnedResultCount: returnedResults,
          siteRejectedCount: siteRejectedResults,
          newUrlCount: newUrls,
          decisionStep: true,
        }, budget);

        if (newUrls === 0 && totalResults === 0) {
          state.addDiary(`empty search for ${gapId}; planner may rewrite later`);
        }

        if (autoReadTopK > 0 || duplicateSerp) {
          let autoReadCount = duplicateSerp ? Math.max(1, autoReadTopK) : autoReadTopK;
          while (budget && autoReadCount > 0 && !budget.canClaim('sourceReads', autoReadCount)) autoReadCount -= 1;
          const picks = autoReadCount > 0 ? pickUnreadCandidates(state, autoReadCount, gapId) : [];
          if (picks.length) {
            successfulAutoReads += await performRead({
              sourceIds: picks.map((candidate) => candidate.id).slice(0, autoReadCount),
              gapId,
              reasonCode: 'auto_read_top_ranked',
              harvest: true,
            });
            if (duplicateSerp) {
              addTrace(trace, state, 'duplicate_serp_redirect', {
                reasonCode: 'read_unread_candidate',
                targetGapIds: [gapId],
                sourceIds: picks.map((candidate) => candidate.id),
              }, budget);
            }
          } else if (duplicateSerp) {
            markRepairAngleExhausted(gap, searchQueries);
            addTrace(trace, state, 'duplicate_serp_redirect', {
              reasonCode: 'angle_exhausted_rotate_slot',
              targetGapIds: [gapId],
            }, budget, 'skipped');
          }
        }
        const progressKind = (newUrls > 0 || totalResults > 0 || successfulAutoReads > 0)
          ? 'progress'
          : classifySearchProgress({
            error: searchResults.find((item) => isTransientSearchError(item.error))?.error || null,
            skipped: duplicateSerp ? 'duplicate_results' : null,
            newUrls,
            resultCount: totalResults,
          });
        state.noteProgressKind(progressKind);
        if (progressKind === 'progress') {
          consecutiveInvalidSteps = 0;
          state.clearPlannerFailure({ gapId });
        } else if (progressKind === 'transient' || progressKind === 'duplicate') {
          addTrace(trace, state, 'recovery', {
            reasonCode: progressKind === 'transient' ? 'transient_provider_error' : 'duplicate_no_yield',
            recoveryState: progressKind,
            targetGapIds: [gapId],
          }, budget, 'retry');
        } else {
          consecutiveInvalidSteps += 1;
          state.recovery.invalidSteps += 1;
          addTrace(trace, state, 'recovery', {
            reasonCode: 'zero_evidence_action',
            recoveryState: 'no_yield',
            targetGapIds: [gapId],
            consecutiveInvalidSteps,
          }, budget, 'retry');
          if (consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps) {
            stopReason = STOP_REASONS.safetyCap;
            stopDetail = safetyStopDetail(state, { trigger: 'consecutive_invalid' });
            addTrace(trace, state, 'stop', {
              reasonCode: stopReason,
              stopDetail,
              targetGapIds: [gapId],
            }, budget);
            break;
          }
        }
        continue;
      }

      if (action.action === 'read') {
        state.forbidFinalizeUntilExplore = false;
        const successfulReads = await performRead({
          sourceIds: action.sourceIds.slice(0, maxReads),
          gapId: action.gapId,
          reasonCode: action.reasonCode || 'agent_read',
          harvest: false,
        });
        if (successfulReads > 0) {
          consecutiveInvalidSteps = 0;
          state.clearPlannerFailure({ gapId: action.gapId });
        } else {
          consecutiveInvalidSteps += 1;
          state.recovery.invalidSteps += 1;
          if (consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps) {
            stopReason = STOP_REASONS.safetyCap;
            stopDetail = safetyStopDetail(state, { trigger: 'consecutive_invalid' });
            addTrace(trace, state, 'stop', {
              reasonCode: stopReason,
              stopDetail,
              targetGapIds: [action.gapId].filter(Boolean),
            }, budget);
            break;
          }
        }
        continue;
      }

      if (action.action === 'reflect') {
        let gapQuestion = String(action.gapQuestion || '').trim();
        if (!gapQuestion && dynamicGapCount(state) < maxOpenGaps) {
          const tokensBefore = budget?.usage?.llmTokens || 0;
          const suggestions = await decomposeQuery({ llm, state, signal, maxSubQuestions: 1 });
          state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
          gapQuestion = suggestions.find((question) => !state.gaps.some((gap) => gap.question === question)) || '';
        }
        if (gapQuestion && dynamicGapCount(state) < maxOpenGaps) {
          const gap = state.addGap(gapQuestion);
          if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
          else gapQuestion = '';
        }
        if (gapQuestion) consecutiveInvalidSteps = 0;
        else consecutiveInvalidSteps += 1;
        state.addDiary(gapQuestion ? `reflected, opened gap "${gapQuestion.slice(0, 80)}"` : 'reflected, no new gap');
        addTrace(trace, state, 'reflect', { reasonCode: action.reasonCode || 'agent_reflect', targetGapIds: state.gaps.map((gap) => gap.id), decisionStep: true }, budget);
        continue;
      }

      if (FINALIZE_ACTIONS.has(action.action)) {
        const currentGate = refreshState();
        const hasDirectEvidence = state.hasBodyEvidence();
        const continueOk = canContinueLoop();
        if (state.cycle.afterSearch && !state.cycleHasSuccessfulBody() && continueOk) {
          state.observations.push({ type: 'evaluation', verdict: 'needs_body_after_search' });
          state.addDiary('finalize rejected: no successful body in this search-read cycle');
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
          continue;
        }
        if (!hasDirectEvidence && continueOk && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
          state.evaluationRetries += 1;
          state.observations.push({ type: 'evaluation', verdict: 'needs_more_evidence' });
          state.addDiary('answer rejected: missing direct evidence');
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
          continue;
        }
        if (!currentGate?.pass && pendingStopReason !== STOP_REASONS.budgetExhausted && pendingStopReason !== STOP_REASONS.safetyCap) {
          const shouldLlmGate = answerGateEnabled
            && (gateMode === 'llm' || gateMode === 'rules-then-llm')
            && state.evaluationRetries < maxRetries;
          let evaluation = null;
          if (shouldLlmGate) {
            const tokensBefore = budget?.usage?.llmTokens || 0;
            evaluation = await evaluateAnswerReadiness({ llm, state, signal });
            state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
          }
          if (evaluation?.llmPass && !currentGate.pass) {
            addTrace(trace, state, 'evaluate_report', {
              reasonCode: 'llm_cannot_override_gate',
              missingAspect: evaluation.missingAspect || null,
            }, budget, 'rejected');
          }
          if (continueOk && belowHardCapFrom(state) && pendingStopReason !== STOP_REASONS.budgetExhausted && pendingStopReason !== STOP_REASONS.safetyCap) {
            state.evaluationRetries += 1;
            state.forbidFinalizeUntilExplore = true;
            if (evaluation?.missingAspect && dynamicGapCount(state) < maxOpenGaps) {
              const gap = state.addGap(evaluation.missingAspect, 'critical');
              if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
            }
            state.observations.push({
              type: 'evaluation',
              verdict: 'answer_gate_failed',
              missingAspect: evaluation?.missingAspect || currentGate.failures?.[0]?.code || null,
            });
            state.addDiary(`readiness gate failed; keep exploring${evaluation?.missingAspect ? `: ${evaluation.missingAspect.slice(0, 80)}` : ''}`);
            addTrace(trace, state, 'evaluate_report', {
              reasonCode: evaluation?.missingAspect ? 'answer_gate_failed' : (currentGate.failures?.[0]?.code || 'readiness_gate_failed'),
              missingAspect: evaluation?.missingAspect || null,
              failures: currentGate.failures,
            }, budget, 'retry');
            continue;
          }
          stopReason = resolveNewRunStopReason(pendingStopReason, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          });
          addTrace(trace, state, 'evaluate_report', {
            reasonCode: 'answer_gate_failed',
            missingAspect: evaluation?.missingAspect || null,
            terminal: true,
            failures: currentGate.failures,
          }, budget, 'failed');
          addTrace(trace, state, 'answer', {
            reasonCode: action.reasonCode || stopReason,
            stopReason,
          }, budget);
          break;
        }
        if (currentGate?.pass && belowMin && continueOk && pendingStopReason !== STOP_REASONS.budgetExhausted) {
          action = fallbackAdaptiveAction(state, { belowMin: true, readiness: currentGate });
          if (!FINALIZE_ACTIONS.has(action.action)) {
            state.addDiary('gate passed but token floor not reached; keep exploring');
            continue;
          }
          if (belowMin) {
            state.addDiary('token floor not reached; refusing evidence_sufficient');
            continue;
          }
        }
        stopReason = mapFinalizeStopReason(action, pendingStopReason, Boolean(currentGate?.pass) && !belowMin)
          || (currentGate?.pass && !belowMin
            ? STOP_REASONS.evidenceSufficient
            : resolveNewRunStopReason(pendingStopReason, { step: state.step, maxSteps: state.maxSteps, budget }));
        if (stopReason === STOP_REASONS.evidenceSufficient && !currentGate?.pass) {
          stopReason = resolveNewRunStopReason(pendingStopReason, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          });
        }
        addTrace(trace, state, 'answer', { reasonCode: action.reasonCode || 'agent_evidence_sufficient', stopReason }, budget);
        break;
      }

      stopReason = resolveNewRunStopReason(action.reasonCode, {
        step: state.step,
        maxSteps: state.maxSteps,
        budget,
      });
      addTrace(trace, state, 'stop', { reasonCode: action.reasonCode || stopReason }, budget);
      break;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      stopReason = STOP_REASONS.userCancelled;
      addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.userCancelled }, budget, 'cancelled');
    } else if (error?.name !== 'BudgetExceededError') {
      throw error;
    } else {
      degraded = true;
      stopReason = STOP_REASONS.budgetExhausted;
      stopRequiredAmount = error.requiredAmount || 1;
      stopDetail = budget?.exhaustionDetail?.({ llmClaim: stopRequiredAmount })
        || ({ searchRequests: 'search_request_cap', sourceReads: 'source_read_cap', llmTokens: 'llm_hard_cap' }[error.kind])
        || error.kind;
      addTrace(trace, state, 'stop', {
        reasonCode: STOP_REASONS.budgetExhausted,
        stopDetail,
        kind: error.kind,
      }, budget, 'budget_exhausted');
    }
  }

  if (!stopReason) {
    stopReason = resolveNewRunStopReason(null, {
      step: state.step,
      maxSteps: state.maxSteps,
      budget,
    });
  }
  if (!(stopReason === STOP_REASONS.budgetExhausted && stopDetail)) {
    stopReason = resolveNewRunStopReason(stopReason, {
      step: state.step,
      maxSteps: state.maxSteps,
      budget,
    });
  }
  if (!stopReason && hasStepCap(state.maxSteps) && state.step >= state.maxSteps) {
    stopReason = STOP_REASONS.safetyCap;
    stopDetail = 'max_steps';
  }

  if (state.findings.length === 0 && state.candidates.size > 0) {
    const fallbackFinding = selectedFinding(state, [...state.candidates.keys()], 'gap-1');
    fallbackFinding.degraded = true;
    state.findings.push(fallbackFinding);
  }
  const recoverySnapshot = state.snapshot().recovery;
  if (degraded) {
    for (const finding of state.findings) finding.degraded = true;
  }
  const notes = state.unresolvedReportNotes();
  const blockedSlots = recoverySnapshot.blockedGaps;
  for (const finding of state.findings) {
    finding.unresolvedGaps = notes.unresolvedGaps;
    finding.blockedHosts = notes.blockedHosts;
    finding.secondaryOnlyClaims = notes.secondaryOnlyClaims;
    finding.unsupportedDecisions = notes.unsupportedDecisions;
    finding.blockedSlots = blockedSlots;
  }
  if (stopReason === STOP_REASONS.budgetExhausted && !stopDetail) {
    stopDetail = budget?.exhaustionDetail?.({ llmClaim: budget?.defaultLlmMaxTokens || 1 }) || null;
  }
  budget?.setControllerStopReason?.(stopReason, stopDetail, stopRequiredAmount);
  refreshState();
  emit({
    stage: 'research_stopped',
    reason: stopReason,
    step: state.step,
    maxSteps: state.maxSteps,
  });
  return attachLoopMeta(state.findings, {
    stopReason,
    stopDetail,
    profile: state.profile,
    brief: state.brief,
    gaps: state.gaps,
    readiness: state.readiness,
    embeddingTraces: state.embeddingTraces,
    marginal: state.snapshot().marginal,
    relevance: state.snapshot().relevance,
    recovery: state.snapshot().recovery,
    searchOutcomes: state.searchOutcomes,
    observability: collectObservabilityMetrics({
      findings: state.findings,
      trace,
      searchOutcomes: state.searchOutcomes,
      agentSnapshotChars: state.lastAgentSnapshotChars,
    }),
    ...notes,
  });
}
