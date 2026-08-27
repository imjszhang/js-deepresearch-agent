import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { applyExploratoryBudget, effectiveExploratoryMaxSteps, resolveExploratorySettings } from '../exploratory-settings.mjs';
import {
  decideAdaptiveAction,
  fallbackAdaptiveAction,
  evaluateAnswerReadiness,
  decomposeQuery,
  pickUnreadCandidates,
  normalizeAgentAction,
} from '../adaptive/agent-policy.mjs';
import { ResearchState, hostnameOf } from '../adaptive/research-state.mjs';
import { classifyResearchQuery } from '../adaptive/exploratory-sufficiency.mjs';
import { inferResearchProfile, planResearchProfile, plannedOrthogonalGaps } from '../adaptive/research-profile.mjs';
import { evaluateReadinessGate, repairGapsFromGate } from '../adaptive/readiness-gate.mjs';
import { annotateBodyQuality, isSuccessfulBody } from '../adaptive/body-quality.mjs';
import { requiredHostQueries } from '../adaptive/source-policy.mjs';
import { unreadForGap, markCandidateStatus } from '../adaptive/url-pool.mjs';
import { clusterUrlPool, queriesAreNearDuplicates, readAddedNewInfo } from '../adaptive/embedding-signals.mjs';
import { STOP_REASONS, mapControllerStopReason } from '../adaptive/stop-reasons.mjs';
import { attachExploratoryController, buildForcedReportLimitations } from '../adaptive/unresolved-report.mjs';
import { selectRelevantPassages } from '../passage-selector.mjs';

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

function selectedFinding(state, sourceIds, gapId) {
  const sources = sourceIds.map((id) => state.candidates.get(id)).filter(Boolean);
  const gap = state.gapById(gapId);
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

function gatePasses(state) {
  return Boolean(state.readiness?.pass || state.sufficiency?.sufficient);
}

function unreadForRerank(candidates, gap) {
  const scoped = unreadForGap(candidates, gap?.id).filter((candidate) => !candidate.status || candidate.status === 'unread');
  if (scoped.length) return scoped;
  return [...candidates.values()].filter((candidate) => !candidate.status || candidate.status === 'unread');
}

async function observeRerank({ state, gap, providers, signal, trace, budget }) {
  const unread = unreadForRerank(state.candidates, gap);
  if (!providers?.rerank?.rerank || !unread.length) return null;
  const query = gap?.question || state.query;
  const documents = unread.map((source) => ({
    id: source.id,
    text: [source.title, source.snippet, source.summary].filter(Boolean).join('\n'),
  }));
  const startedAt = Date.now();
  const result = await providers.rerank.rerank({ query, documents, signal });
  for (const item of result.items) {
    const candidate = state.candidates.get(item.id);
    if (candidate) {
      candidate.rerank = { score: item.score, provider: result.provider, model: result.model, degraded: result.degraded };
      candidate.rerankScore = item.score;
    }
  }
  const record = {
    query,
    model: result.model,
    provider: result.provider,
    inputCount: documents.length,
    durationMs: result.durationMs ?? (Date.now() - startedAt),
    degraded: Boolean(result.degraded),
    selectedReason: 'current_gap_unread',
    gapId: gap?.id || null,
  };
  addTrace(trace, state, 'rerank', {
    reasonCode: result.degraded ? 'rerank_degraded' : 'rerank_completed',
    ...record,
  }, budget, result.degraded ? 'degraded' : 'success');
  return record;
}

export async function runAdaptiveV2(context) {
  const { query, llm, search, signal, emit, settings, budget, queryMemory, trace, researchProviders } = context;
  const exploratory = resolveExploratorySettings(settings);
  const focused = resolveFocusedSettings(settings);
  const queryShape = classifyResearchQuery(query);
  applyExploratoryBudget(budget, exploratory);
  const maxSteps = effectiveExploratoryMaxSteps(exploratory, budget?.limits?.llmTokens);
  const embedding = researchProviders?.embedding || null;
  const state = new ResearchState({
    query,
    maxSteps,
    maxGapDepth: exploratory.maxGapDepth,
    minLlmTokens: exploratory.minLlmTokens,
    targetLlmTokens: exploratory.minLlmTokens,
    budget,
    profile: inferResearchProfile(query),
  });
  const maxReads = Math.max(1, Number(exploratory.maxReadsPerStep) || 3);
  const maxRetries = Math.max(0, Number(exploratory.maxEvaluationRetries) || 0);
  const maxOpenGaps = Number(exploratory.maxOpenGaps) || 8;
  const maxQueriesPerStep = Math.max(1, Number(exploratory.maxQueriesPerStep) || 3);
  const autoReadTopK = Math.min(Math.max(0, Number(exploratory.autoReadTopK ?? 2)), maxReads);
  const answerGateEnabled = exploratory.answerGate !== false;
  const gateMode = exploratory.gateMode || 'rules-then-llm';
  let degraded = false;
  let stopReason = null;
  let pendingStopReason = null;

  emit({ stage: 'assessing_query', step: 0, maxSteps: state.maxSteps });
  if (queryShape.kind !== 'definitional' && exploratory.profilePlanner !== false) {
    const tokensBefore = budget?.usage?.llmTokens || 0;
    state.applyProfile(await planResearchProfile({ query, llm, signal }));
    state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
  } else {
    state.applyProfile(state.profile);
  }
  emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
  addTrace(trace, state, 'assess', {
    reasonCode: 'agent_loop_v2',
    targetGapIds: ['gap-1'],
    profile: state.profile?.requirements || null,
    requiredHosts: state.profile?.requiredHosts || [],
  }, budget);

  function refreshState() {
    state.refreshBudgetView({
      budget,
      minLlmTokens: exploratory.minLlmTokens,
      actionCosts: state.actionCosts,
    });
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
    finding.sources = (finding.sources || []).map((source) => annotateBodyQuality(source));
    if (embedding && focused.fetchMode !== 'extract') {
      for (const source of finding.sources) {
        if (!isSuccessfulBody(source) || String(source.content || '').length < 600) continue;
        try {
          source.summary = await selectRelevantPassages({
            query,
            question: finding.question,
            content: source.content,
            snippet: source.snippet,
            embedding,
            signal,
          }) || source.summary;
          source.extractionMethod = source.extractionMethod || 'embedding';
        } catch {
          // Passage selection is optional; keep the fetched body.
        }
      }
    }
    const previousTexts = state.knowledge.map((item) => item.learned);
    state.findings.push(finding);
    const readHostnames = [];
    let successful = 0;
    const gap = state.gapById(finding.gapId);
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      const existing = state.candidates.get(id) || {};
      const merged = { ...existing, ...source, id, freq: existing.freq || 1 };
      if (isSuccessfulBody(merged)) {
        merged.status = 'read';
        state.readSourceIds.add(id);
        successful += 1;
        if (gap && !gap.readSourceIds.includes(id)) gap.readSourceIds.push(id);
        const novelty = await readAddedNewInfo({
          embedding,
          traces: state.embeddingTraces,
          signal,
          previousTexts,
          nextText: source.summary || source.content || source.snippet,
        });
        source.novelty = novelty;
        state.addKnowledge({ gapId: finding.gapId, sourceId: id, learned: source.summary || source.content || source.snippet });
      } else if (merged.fetchStatus === 'waf' || merged.bodyQuality === 'waf') {
        merged.status = 'waf';
        state.failedSourceIds.add(id);
        markCandidateStatus(state.candidates, id, 'waf', 'waf_or_error_body');
        if (gap && hostnameOf(merged.url)) {
          const host = hostnameOf(merged.url);
          if ((gap.requiredHosts || []).some((required) => host.endsWith(required))) {
            if (!gap.blockedHosts.includes(host)) gap.blockedHosts.push(host);
          }
        }
      } else {
        merged.status = 'failed';
        state.failedSourceIds.add(id);
        markCandidateStatus(state.candidates, id, 'failed', source.fetchError || 'read_failed');
      }
      state.candidates.set(id, merged);
      const hostname = hostnameOf(source.url || id);
      if (hostname) readHostnames.push(hostname);
    }
    state.recordSuccessfulBodies(successful);
    state.observations.push({
      type: 'read_result',
      sourceIds,
      successful,
      harvest,
      waf: (finding.sources || []).filter((source) => source.fetchStatus === 'waf').length,
    });
    state.addDiary(`${harvest ? 'policy-read' : 'read'} ${sourceIds.length} source(s) (${readHostnames.join(', ') || 'unknown hosts'}) for ${finding.gapId}; ${successful} successful`);
    state.actionCosts.record('read', (budget?.usage?.llmTokens || 0) - tokensBefore);
    state.syncGapCoverage();
    addTrace(trace, state, 'read', {
      reasonCode,
      targetGapIds: [finding.gapId],
      sourceIds,
      knowledgeCount: state.knowledge.length,
      harvest,
      decisionStep: !harvest,
      successfulBodyReads: successful,
    }, budget);
    return successful;
  }

  if (queryShape.kind === 'definitional') {
    addTrace(trace, state, 'decompose', {
      reasonCode: 'decompose_skipped_definitional',
      targetGapIds: state.gaps.map((gap) => gap.id),
      subQuestionCount: 0,
    }, budget, 'skipped');
  } else {
    const tokensBefore = budget?.usage?.llmTokens || 0;
    const subQuestions = await decomposeQuery({ llm, state, signal });
    state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
    for (const question of subQuestions) {
      if (state.gaps.length >= maxOpenGaps) break;
      const gap = state.addGap(question);
      if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
    }
    for (const planned of plannedOrthogonalGaps(state.profile, state.gaps)) {
      if (state.gaps.length >= maxOpenGaps) break;
      const gap = state.addGap(planned.question, planned.priority, planned);
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
      refreshState();

      if (budget && !loopCanAfford(budget, state.actionCosts.estimate('decide'))) {
        stopReason = STOP_REASONS.budgetExhausted;
        state.markRemainingGapsMissing();
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted }, budget, 'budget_exhausted');
        break;
      }

      const belowMin = Boolean(state.budgetView?.belowMin);
      let action;
      if (state.budgetView?.hardCapReached) {
        stopReason = STOP_REASONS.budgetExhausted;
        state.markRemainingGapsMissing();
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted }, budget, 'budget_exhausted');
        break;
      } else if (countCapsExhausted(budget)) {
        action = { action: 'finalize', reasonCode: STOP_REASONS.budgetExhausted };
        pendingStopReason = STOP_REASONS.budgetExhausted;
        degraded = true;
      } else if (gatePasses(state) && !belowMin) {
        action = { action: 'finalize', reasonCode: 'evidence_sufficient' };
      } else {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        action = await decideAdaptiveAction({ llm, state, signal });
        state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
        if (belowMin && action && ['answer', 'stop', 'finalize', 'draft'].includes(action.action)) {
          action = fallbackAdaptiveAction(state, { belowMin: true, sufficiency: state.sufficiency, readiness: state.readiness });
        }
      }

      action = normalizeAgentAction(action);
      let invalid = pendingStopReason === STOP_REASONS.budgetExhausted ? null : state.validate(action);
      let searchQueries = [];
      if (!invalid && action.action === 'search') {
        for (const candidateQuery of normalizeSearchQueries(action, maxQueriesPerStep)) {
          const duplicate = await queryMemory?.findDuplicate?.(candidateQuery, action.gapId || 'gap-1');
          if (duplicate) continue;
          let nearDuplicate = state.searchedQueries().some((previous) => previous === candidateQuery);
          if (!nearDuplicate) {
            for (const previous of state.searchedQueries()) {
              const near = await queriesAreNearDuplicates(candidateQuery, previous, {
                embedding,
                traces: state.embeddingTraces,
                signal,
              });
              if (near.duplicate) {
                nearDuplicate = true;
                break;
              }
            }
          }
          if (!nearDuplicate) searchQueries.push(candidateQuery);
        }
        if (!searchQueries.length) invalid = 'duplicate_query';
      }
      if (invalid) {
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        state.addDiary(`${action?.action || 'unknown'} rejected (${invalid})`);
        addTrace(trace, state, action?.action || 'unknown', { reasonCode: invalid }, budget, 'rejected');
        action = normalizeAgentAction(fallbackAdaptiveAction(state, {
          sufficiency: state.sufficiency,
          readiness: state.readiness,
          belowMin,
        }));
        invalid = state.validate(action);
        if (invalid) action = { action: 'finalize', reasonCode: invalid };
        if (action.action === 'search') searchQueries = normalizeSearchQueries(action, maxQueriesPerStep);
      }
      const stepsRemaining = hasStepCap(state.maxSteps) ? state.maxSteps - state.step : null;
      if (stepsRemaining !== null && stepsRemaining <= 1 && !['finalize', 'draft', 'answer', 'stop'].includes(action.action)
        && (state.findings.length > 0 || state.candidates.size > 0)) {
        addTrace(trace, state, action.action, { reasonCode: 'forced_final_answer' }, budget, 'forced');
        action = { action: 'finalize', reasonCode: 'forced_final_answer' };
        pendingStopReason = STOP_REASONS.safetyCap;
      }
      state.step += 1;
      state.lastAction = action.action === 'finalize' && action.reasonCode === 'forced_final_answer'
        ? 'finalize'
        : (action.action === 'finalize' ? 'finalize' : action.action);
      abort(signal);

      if (action.action === 'search') {
        const requestedGapId = action.gapId || state.focusGap()?.id || 'gap-1';
        const gap = state.gapById(requestedGapId);
        const gapId = gap.id;
        const seeded = [...searchQueries];
        if ((gap.requiredHosts || []).length) {
          for (const hostQuery of requiredHostQueries(gap, { alreadySearched: [...state.searchedQueries(), ...seeded] })) {
            if (seeded.length >= maxQueriesPerStep) break;
            seeded.push(hostQuery);
          }
        }
        const allowedQueries = [];
        for (const searchQuery of seeded) {
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
          const added = state.addCandidates(results, gapId, searchQuery);
          newUrls += added.added || 0;
          addSerpKnowledge(state, results, gapId);
          state.markGapSearched(gapId, searchQuery);
          state.observations.push({ type: 'search_result', query: searchQuery, resultCount: results.length, newUrls: added.added || 0 });
        }
        state.recordSearchCycle({ gapId, newUrls });
        await clusterUrlPool(state.candidates, { embedding, traces: state.embeddingTraces, signal });
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

        if (newUrls === 0) {
          const nextHostQuery = requiredHostQueries(gap, { alreadySearched: state.searchedQueries() })[0];
          const otherGap = state.gaps.find((item) => item.id !== gapId && !state.gapCovered(item.id) && item.status !== 'blocked');
          if (nextHostQuery) {
            state.addDiary(`search added no new URLs; will try required-host query`);
          } else if (otherGap) {
            state.addDiary(`search added no new URLs; switching to ${otherGap.id}`);
          } else if ((gap.requiredHosts || []).length) {
            state.markGapBlocked(gapId);
            addTrace(trace, state, 'search', { reasonCode: 'source_blocked', targetGapIds: [gapId] }, budget, 'blocked');
          }
        }

        if (autoReadTopK > 0) {
          let autoReadCount = Math.min(autoReadTopK, maxReads);
          while (budget && autoReadCount > 0 && !budget.canClaim('sourceReads', autoReadCount)) autoReadCount -= 1;
          const picks = autoReadCount > 0 ? pickUnreadCandidates(state, autoReadCount, gap) : [];
          if (picks.length) {
            await performRead({
              sourceIds: picks.map((candidate) => candidate.id).slice(0, autoReadCount),
              gapId,
              reasonCode: 'auto_read_top_ranked',
              harvest: true,
            });
          }
        }
        state.lastAction = 'search';
        continue;
      }

      if (action.action === 'read') {
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
        addTrace(trace, state, 'reflect', { reasonCode: action.reasonCode || 'agent_reflect', targetGapIds: state.gaps.map((item) => item.id), decisionStep: true }, budget);
        continue;
      }

      if (action.action === 'draft' || action.action === 'finalize') {
        refreshState();
        const canContinue = (!hasStepCap(state.maxSteps) || state.step < state.maxSteps)
          && loopCanAfford(budget, state.actionCosts.estimate('search'))
          && !state.budgetView?.hardCapReached
          && !countCapsExhausted(budget)
          && pendingStopReason !== STOP_REASONS.budgetExhausted
          && pendingStopReason !== STOP_REASONS.safetyCap;
        const hasDirectEvidence = state.hasBodyEvidence() && (state.cycleHadSuccessfulBody() || state.lastAction !== 'search');
        if (belowMin && canContinue && !pendingStopReason) {
          state.addDiary('finalize deferred: still below the token floor');
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'below_min_keep_exploring' }, budget, 'retry');
          action = normalizeAgentAction(fallbackAdaptiveAction(state, {
            sufficiency: state.sufficiency,
            readiness: state.readiness,
            belowMin: true,
          }));
          if (action.action === 'search' || action.action === 'read') {
            state.lastAction = action.action;
            if (action.action === 'search') {
              searchQueries = normalizeSearchQueries(action, maxQueriesPerStep);
            }
            // Fall through by restarting the loop with the fallback action.
            state.step -= 1;
            continue;
          }
        }
        if (!hasDirectEvidence && canContinue && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
          state.evaluationRetries += 1;
          state.observations.push({ type: 'evaluation', verdict: 'needs_more_evidence' });
          state.addDiary('answer rejected: missing direct evidence');
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
          continue;
        }

        const deterministicGate = evaluateReadinessGate({
          query: state.query,
          profile: state.profile,
          gaps: state.gaps,
          findings: state.findings,
          missingSubjects: state.sufficiency?.missingSubjects || [],
        });
        const shouldLlmGate = answerGateEnabled
          && !deterministicGate.pass
          && (gateMode === 'llm' || gateMode === 'rules-then-llm')
          && state.evaluationRetries < maxRetries;
        const llmEvaluation = shouldLlmGate
          ? await (async () => {
            const tokensBefore = budget?.usage?.llmTokens || 0;
            const evaluation = await evaluateAnswerReadiness({ llm, state, signal });
            state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
            return evaluation;
          })()
          : null;

        const gate = evaluateReadinessGate({
          query: state.query,
          profile: state.profile,
          gaps: state.gaps,
          findings: state.findings,
          llmPass: llmEvaluation?.pass ?? null,
          missingSubjects: state.sufficiency?.missingSubjects || [],
        });
        state.readiness = gate;
        if (state.sufficiency) state.sufficiency.sufficient = gate.pass;

        if (!gate.pass && pendingStopReason !== STOP_REASONS.budgetExhausted && pendingStopReason !== STOP_REASONS.safetyCap) {
          if (canContinue && state.evaluationRetries < maxRetries) {
            state.evaluationRetries += 1;
            const repairs = repairGapsFromGate(gate, state.gaps);
            for (const repair of repairs) {
              if (state.gaps.length >= maxOpenGaps) break;
              const opened = state.addGap(repair.question, repair.priority, repair);
              if (opened) emit({ stage: 'gap_opened', gapId: opened.id, question: opened.question });
            }
            if (llmEvaluation?.pass === false && llmEvaluation.missingAspect && state.gaps.length < maxOpenGaps) {
              const opened = state.addGap(llmEvaluation.missingAspect, 'critical', { inheritProfile: true });
              if (opened) emit({ stage: 'gap_opened', gapId: opened.id, question: opened.question });
            }
            state.observations.push({
              type: 'evaluation',
              verdict: 'answer_gate_failed',
              missingAspect: llmEvaluation?.missingAspect || gate.failures[0]?.repairQuestion || null,
              llmPassIgnored: llmEvaluation?.pass === true,
            });
            state.addDiary(`readiness gate failed${gate.failures[0] ? `: ${gate.failures[0].code}` : ''}`);
            addTrace(trace, state, 'evaluate_report', {
              reasonCode: 'answer_gate_failed',
              missingAspect: llmEvaluation?.missingAspect || gate.failures[0]?.repairQuestion || null,
              llmOverrideIgnored: llmEvaluation?.pass === true,
              failures: gate.failures,
            }, budget, 'retry');
            continue;
          }
          if (gate.decision === 'source_blocked' || gate.blockedRequired) {
            pendingStopReason = pendingStopReason || STOP_REASONS.sourceBlocked;
          }
          state.observations.push({
            type: 'evaluation',
            verdict: 'answer_gate_failed_terminal',
            missingAspect: llmEvaluation?.missingAspect || null,
          });
          addTrace(trace, state, 'evaluate_report', {
            reasonCode: 'answer_gate_failed',
            missingAspect: llmEvaluation?.missingAspect || null,
            terminal: true,
            llmOverrideIgnored: llmEvaluation?.pass === true,
          }, budget, 'failed');
        }

        const mapped = mapControllerStopReason(action, pendingStopReason, gate.pass);
        const hitStepCap = hasStepCap(state.maxSteps) && state.step >= state.maxSteps;
        stopReason = mapped
          || (gate.pass && !pendingStopReason ? STOP_REASONS.evidenceSufficient : null)
          || pendingStopReason
          || (gate.blockedRequired ? STOP_REASONS.sourceBlocked : null)
          || (hitStepCap ? STOP_REASONS.safetyCap : STOP_REASONS.budgetExhausted);
        if (stopReason === STOP_REASONS.evidenceSufficient && !gate.pass) {
          stopReason = pendingStopReason
            || (gate.blockedRequired ? STOP_REASONS.sourceBlocked : null)
            || (hitStepCap ? STOP_REASONS.safetyCap : STOP_REASONS.budgetExhausted);
        }
        if (['budget_exhausted', 'source_blocked', 'safety_cap'].includes(stopReason)) {
          state.markRemainingGapsMissing();
        }
        addTrace(trace, state, action.action === 'draft' ? 'draft' : 'answer', {
          reasonCode: action.reasonCode || (gate.pass ? 'agent_evidence_sufficient' : stopReason),
          stopReason,
        }, budget);
        break;
      }

      stopReason = action.reasonCode === STOP_REASONS.budgetExhausted
        ? STOP_REASONS.budgetExhausted
        : STOP_REASONS.safetyCap;
      addTrace(trace, state, 'stop', { reasonCode: action.reasonCode || stopReason }, budget);
      break;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.userCancelled }, budget, 'cancelled');
      throw error;
    }
    if (error?.name !== 'BudgetExceededError') throw error;
    degraded = true;
    stopReason = STOP_REASONS.budgetExhausted;
    state.markRemainingGapsMissing();
    addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, kind: error.kind }, budget, 'budget_exhausted');
  }

  if (!stopReason) {
    if (budget?.limits?.llmTokens && !budget.canClaim('llmTokens', 1)) stopReason = STOP_REASONS.budgetExhausted;
    else if (hasStepCap(state.maxSteps) && state.step >= state.maxSteps) stopReason = STOP_REASONS.safetyCap;
    else stopReason = gatePasses(state) ? STOP_REASONS.evidenceSufficient : STOP_REASONS.budgetExhausted;
  }

  if (state.findings.length === 0 && state.candidates.size > 0) {
    const fallbackFinding = selectedFinding(state, [...state.candidates.keys()], 'gap-1');
    fallbackFinding.degraded = true;
    state.findings.push(fallbackFinding);
  }
  if (degraded) {
    for (const finding of state.findings) finding.degraded = true;
  }
  refreshState();
  const limitations = buildForcedReportLimitations({
    stopReason,
    gaps: state.gaps,
    findings: state.findings,
    candidates: state.candidates,
    profile: state.profile,
  });
  budget?.setControllerStopReason?.(stopReason);
  emit({
    stage: 'research_stopped',
    reason: stopReason,
    step: state.step,
    maxSteps: state.maxSteps,
  });
  return attachExploratoryController(state.findings, {
    profile: state.profile,
    gaps: state.gaps,
    readiness: state.readiness,
    stopReason,
    limitations,
    embeddingTraces: state.embeddingTraces,
    urlPool: [...state.candidates.values()].map((candidate) => ({
      id: candidate.id,
      hostname: candidate.hostname,
      tier: candidate.tier,
      status: candidate.status,
      gapId: candidate.gapId,
      selectReason: candidate.selectReason || null,
      skipReason: candidate.skipReason || null,
    })),
  });
}
