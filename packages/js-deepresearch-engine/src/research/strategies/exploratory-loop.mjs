import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { applyExploratoryBudget, effectiveExploratoryMaxSteps, resolveExploratorySettings } from '../exploratory-settings.mjs';
import { decideAdaptiveAction, fallbackAdaptiveAction, evaluateAnswerReadiness, decomposeQuery, pickUnreadCandidates, buildAngleChangeSearch, belowHardCapFrom } from '../adaptive/agent-policy.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';
import { classifyResearchQuery } from '../adaptive/exploratory-sufficiency.mjs';
import { inferResearchProfile, planResearchProfile } from '../adaptive/research-profile.mjs';
import { classifyFetchedBody } from '../body-quality.mjs';
import { shortSearchTerms } from '../adaptive/source-policy.mjs';
import {
  EXPLORATORY_STOP_REASONS,
  mapFinalizeStopReason,
  resolveNewRunStopReason,
} from '../adaptive/stop-reasons.mjs';
import {
  clusterUrlRecords,
  queriesAreNearDuplicates,
  readAddsNovelty,
} from '../adaptive/embedding-signals.mjs';
import { similarQuestions } from '../adaptive/exploratory-sufficiency.mjs';

const STOP_REASONS = {
  evidenceSufficient: EXPLORATORY_STOP_REASONS.evidenceSufficient,
  budgetExhausted: EXPLORATORY_STOP_REASONS.budgetExhausted,
  safetyCap: EXPLORATORY_STOP_REASONS.safetyCap,
  userCancelled: EXPLORATORY_STOP_REASONS.userCancelled,
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

function countCapsExhausted(budget) {
  if (!budget) return false;
  const searchLimit = Number(budget.limits?.searchRequests) || 0;
  const readLimit = Number(budget.limits?.sourceReads) || 0;
  if (searchLimit > 0 && !budget.canClaim('searchRequests')) return true;
  if (readLimit > 0 && !budget.canClaim('sourceReads')) return true;
  return Boolean(
    budget.exhaustedKinds?.has?.('searchRequests')
    || budget.exhaustedKinds?.has?.('sourceReads')
    || budget.stopReason === 'searchRequests'
    || budget.stopReason === 'sourceReads',
  );
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

function normalizeSearchQueries(action, maxQueries) {
  const queries = Array.isArray(action.queries) ? action.queries : [];
  const merged = [String(action.query || '').trim(), ...queries.map((query) => String(query || '').trim())];
  return [...new Set(merged.filter(Boolean))].slice(0, maxQueries);
}

async function filterDuplicateQueries(queries, { state, queryMemory, gapId, embedding, signal }) {
  const accepted = [];
  for (const candidateQuery of queries) {
    const memoryHit = await queryMemory?.findDuplicate?.(candidateQuery, gapId);
    if (memoryHit) continue;
    let duplicate = state.searchedQueries().some((seen) => similarQuestions(seen, candidateQuery, 0.86));
    if (!duplicate && embedding) {
      for (const seen of state.searchedQueries()) {
        if (await queriesAreNearDuplicates(seen, candidateQuery, {
          embedding,
          signal,
          traces: state.embeddingTraces,
        })) {
          duplicate = true;
          break;
        }
      }
    }
    if (!duplicate) accepted.push(candidateQuery);
  }
  return accepted;
}

async function observeRerank({ state, gap, providers, signal, trace, budget }) {
  if (!providers?.rerank) return null;
  const unread = [...state.candidates.values()].filter((source) => (
    source.gapId === gap.id
    && !state.readSourceIds.has(source.id)
    && source.status !== 'read'
    && source.status !== 'failed'
    && source.status !== 'waf'
    && source.status !== 'duplicate'
  ));
  if (!unread.length) return null;
  const documents = unread.map((source) => ({
    id: source.id,
    text: [source.title, source.snippet, source.summary].filter(Boolean).join('\n'),
  }));
  const query = gap.question || state.query;
  const startedAt = Date.now();
  const result = await providers.rerank.rerank({ query, documents, signal });
  for (const item of result.items) {
    const candidate = state.candidates.get(item.id);
    if (candidate) {
      candidate.rerank = { score: item.score, provider: result.provider, degraded: result.degraded };
      candidate.rerankScore = item.score;
    }
  }
  const traceRecord = {
    query,
    model: result.model || providers.rerank.model || null,
    provider: result.provider,
    inputCount: documents.length,
    durationMs: result.durationMs || (Date.now() - startedAt),
    degraded: Boolean(result.degraded),
    selectedReason: 'current_gap_unread',
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
  const focused = resolveFocusedSettings(settings);
  const queryShape = classifyResearchQuery(query);
  applyExploratoryBudget(budget, exploratory);
  const maxSteps = effectiveExploratoryMaxSteps(exploratory, budget?.limits?.llmTokens);
  let profile = inferResearchProfile(query);
  const state = new ResearchState({
    query,
    maxSteps,
    maxGapDepth: exploratory.maxGapDepth,
    minLlmTokens: exploratory.minLlmTokens,
    targetLlmTokens: exploratory.minLlmTokens,
    budget,
    profile,
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
  let pendingStopReason = null;

  emit({ stage: 'assessing_query', step: 0, maxSteps: state.maxSteps });
  emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
  addTrace(trace, state, 'assess', {
    reasonCode: 'exploratory_loop',
    targetGapIds: ['gap-1'],
    profile: {
      flags: profile.flags,
      requiredHosts: profile.requiredHosts,
      method: profile.method,
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
    let finding = selectedFinding(state, sourceIds, gapId);
    finding = (await enrichFindings([finding], {
      query,
      fetchMode: focused.fetchMode,
      maxUrlsPerIteration: maxReads,
      maxUrlsTotal: maxReads,
      maxContentChars: focused.maxContentChars,
      enrichConcurrency: focused.enrichConcurrency,
      llm,
      signal,
      settings,
      budget,
      embedding,
    }))[0];
    const classifiedSources = [];
    let successful = 0;
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      const quality = classifyFetchedBody(source);
      const next = {
        ...source,
        id,
        bodyQuality: quality.status,
        fetchStatus: quality.status === 'waf' ? 'waf' : source.fetchStatus,
      };
      classifiedSources.push(next);
      state.readSourceIds.add(id);
      const existing = state.candidates.get(id) || {};
      state.candidates.set(id, { ...existing, ...next, id, freq: existing.freq || 1 });
      state.markCandidateStatus(id, quality.status, quality.reason);
      if (quality.successful) {
        successful += 1;
        state.noteSuccessfulBody();
        state.addKnowledge({ gapId: finding.gapId, sourceId: id, learned: next.summary || next.content || next.snippet });
        const known = state.knowledge.map((item) => item.learned);
        const novelty = await readAddsNovelty({
          embedding,
          newText: next.summary || next.content || '',
          knownTexts: known.slice(0, -1),
          signal,
          traces: state.embeddingTraces,
        });
        next.novelty = novelty.novel;
      }
      const gap = state.getGap(finding.gapId);
      if (gap && !gap.readSourceIds.includes(id)) gap.readSourceIds.push(id);
    }
    finding.sources = classifiedSources;
    state.findings.push(finding);
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
    addTrace(trace, state, 'read', {
      reasonCode,
      targetGapIds: [finding.gapId],
      sourceIds,
      knowledgeCount: state.knowledge.length,
      harvest,
      decisionStep: !harvest,
      successfulBodies: successful,
    }, budget);
    return successful;
  }

  const profileTokensBefore = budget?.usage?.llmTokens || 0;
  profile = await planResearchProfile({ llm, query, profile, signal });
  state.profile = profile;
  state.gaps[0] = {
    ...state.gaps[0],
    requiredHosts: profile.requiredHosts ?? [],
    preferredHosts: profile.preferredHosts ?? [],
    requiredSourceTypes: profile.requiredSourceTypes ?? [],
    minIndependentSources: profile.minIndependentSources || 1,
  };
  state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - profileTokensBefore);

  if (queryShape.kind === 'definitional') {
    addTrace(trace, state, 'decompose', {
      reasonCode: 'decompose_skipped_definitional',
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
      if (state.gaps.length >= maxOpenGaps) break;
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
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted }, budget, 'budget_exhausted');
        break;
      }

      const belowMin = Boolean(state.budgetView?.belowMin);
      const belowHardCap = belowHardCapFrom(state);
      let action;
      if (state.budgetView?.hardCapReached) {
        stopReason = STOP_REASONS.budgetExhausted;
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted }, budget, 'budget_exhausted');
        break;
      } else if (countCapsExhausted(budget)) {
        action = { action: 'answer', reasonCode: STOP_REASONS.budgetExhausted };
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
        if (FINALIZE_ACTIONS.has(action?.action) && !gate?.pass && pendingStopReason !== STOP_REASONS.budgetExhausted) {
          action = {
            ...action,
            blockedByGate: true,
          };
        }
      }

      let invalid = pendingStopReason === STOP_REASONS.budgetExhausted ? null : state.validate(action);
      let searchQueries = [];
      if (!invalid && action.action === 'search') {
        const gap = state.getGap(action.gapId || state.focusGap()?.id);
        const rawQueries = normalizeSearchQueries(action, maxQueriesPerStep);
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
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        state.addDiary(`${action?.action || 'unknown'} rejected (${invalid})`);
        addTrace(trace, state, action?.action || 'unknown', { reasonCode: invalid }, budget, 'rejected');
        action = fallbackAdaptiveAction(state, {
          sufficiency: state.sufficiency,
          readiness: gate,
          belowMin,
          belowHardCap,
        });
        invalid = state.validate(action);
        if (invalid && belowHardCap && canContinueLoop()) {
          action = buildAngleChangeSearch(state);
          if (!normalizeSearchQueries(action, maxQueriesPerStep).length) {
            action = {
              action: 'search',
              query: `${shortSearchTerms(state.query)} ${state.step + 1}`,
              gapId: state.focusGap()?.id || 'gap-1',
              reasonCode: 'fallback_angle_change',
            };
          }
          invalid = state.validate(action);
        }
        if (invalid) {
          if (belowHardCap && canContinueLoop()) {
            action = {
              action: 'search',
              query: `${shortSearchTerms(state.query)} ${state.step}-${state.evaluationRetries}`,
              gapId: state.focusGap()?.id || 'gap-1',
              reasonCode: 'fallback_angle_change',
            };
            invalid = state.validate(action);
          }
          if (invalid) {
            stopReason = resolveNewRunStopReason(pendingStopReason, {
              step: state.step,
              maxSteps: state.maxSteps,
              budget,
            });
            addTrace(trace, state, 'stop', { reasonCode: stopReason }, budget);
            break;
          }
        }
        if (action.action === 'search') searchQueries = normalizeSearchQueries(action, maxQueriesPerStep);
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
        const searchResults = await Promise.all(allowedQueries.map(async (searchQuery) => {
          abort(signal);
          const results = await search.search(searchQuery, { signal });
          return { searchQuery, results };
        }));
        let totalResults = 0;
        let newUrls = 0;
        for (const { searchQuery, results } of searchResults) {
          totalResults += results.length;
          queryMemory?.record?.({ query: searchQuery, gapId, status: results.length ? 'useful' : 'empty', results });
          state.recordSearchedQuery(gapId, searchQuery);
          const clustered = await clusterUrlRecords(results.map((result) => ({
            ...result,
            hostname: result.hostname,
            registrableDomain: result.registrableDomain,
          })), { embedding, signal, traces: state.embeddingTraces });
          const clusterById = Object.fromEntries(clustered.map((item) => [item.id || item.url, item.clusterId]));
          newUrls += state.addCandidates(clustered, gapId, { query: searchQuery, clusterById });
          addSerpKnowledge(state, results, gapId);
          state.observations.push({
            type: 'search_result',
            query: searchQuery,
            resultCount: results.length,
            newUrlCount: newUrls,
            gapId,
          });
        }
        await observeRerank({
          state,
          gap,
          providers: researchProviders,
          signal,
          trace,
          budget,
        });
        state.addDiary(`searched ${allowedQueries.length} quer${allowedQueries.length === 1 ? 'y' : 'ies'}, +${state.candidates.size - candidatesBefore} candidates`);
        addTrace(trace, state, 'search', {
          reasonCode: action.reasonCode || 'agent_search',
          targetGapIds: [gapId],
          queryCount: allowedQueries.length,
          resultCount: totalResults,
          newUrlCount: newUrls,
          decisionStep: true,
        }, budget);

        if (newUrls === 0 && totalResults === 0) {
          state.addDiary(`empty search for ${gapId}; will retry with different short site terms`);
        }

        if (autoReadTopK > 0) {
          let autoReadCount = autoReadTopK;
          while (budget && autoReadCount > 0 && !budget.canClaim('sourceReads', autoReadCount)) autoReadCount -= 1;
          const picks = autoReadCount > 0 ? pickUnreadCandidates(state, autoReadCount, gapId) : [];
          if (picks.length) {
            await performRead({
              sourceIds: picks.map((candidate) => candidate.id).slice(0, autoReadCount),
              gapId,
              reasonCode: 'auto_read_top_ranked',
              harvest: true,
            });
          }
        }
        continue;
      }

      if (action.action === 'read') {
        state.forbidFinalizeUntilExplore = false;
        await performRead({
          sourceIds: action.sourceIds.slice(0, maxReads),
          gapId: action.gapId,
          reasonCode: action.reasonCode || 'agent_read',
          harvest: false,
        });
        continue;
      }

      if (action.action === 'reflect') {
        let gapQuestion = String(action.gapQuestion || '').trim();
        if (!gapQuestion && state.gaps.length < maxOpenGaps) {
          const tokensBefore = budget?.usage?.llmTokens || 0;
          const suggestions = await decomposeQuery({ llm, state, signal, maxSubQuestions: 1 });
          state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
          gapQuestion = suggestions.find((question) => !state.gaps.some((gap) => gap.question === question)) || '';
        }
        if (gapQuestion && state.gaps.length < maxOpenGaps) {
          const gap = state.addGap(gapQuestion);
          if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
          else gapQuestion = '';
        }
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
            if (evaluation?.missingAspect && state.gaps.length < maxOpenGaps) {
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
      addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, kind: error.kind }, budget, 'budget_exhausted');
    }
  }

  if (!stopReason) {
    stopReason = resolveNewRunStopReason(null, {
      step: state.step,
      maxSteps: state.maxSteps,
      budget,
    });
  }
  stopReason = resolveNewRunStopReason(stopReason, {
    step: state.step,
    maxSteps: state.maxSteps,
    budget,
  });

  if (state.findings.length === 0 && state.candidates.size > 0) {
    const fallbackFinding = selectedFinding(state, [...state.candidates.keys()], 'gap-1');
    fallbackFinding.degraded = true;
    state.findings.push(fallbackFinding);
  }
  if (degraded) {
    for (const finding of state.findings) finding.degraded = true;
  }
  const notes = state.unresolvedReportNotes();
  for (const finding of state.findings) {
    finding.unresolvedGaps = notes.unresolvedGaps;
    finding.blockedHosts = notes.blockedHosts;
    finding.secondaryOnlyClaims = notes.secondaryOnlyClaims;
    finding.unsupportedDecisions = notes.unsupportedDecisions;
  }
  budget?.setControllerStopReason?.(stopReason);
  refreshState();
  emit({
    stage: 'research_stopped',
    reason: stopReason,
    step: state.step,
    maxSteps: state.maxSteps,
  });
  return attachLoopMeta(state.findings, {
    stopReason,
    profile: state.profile,
    gaps: state.gaps,
    readiness: state.readiness,
    embeddingTraces: state.embeddingTraces,
    ...notes,
  });
}
