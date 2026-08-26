import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { resolveExploratorySettings } from '../exploratory-settings.mjs';
import { decideAdaptiveAction, fallbackAdaptiveAction, evaluateAnswerReadiness, decomposeQuery, pickUnreadCandidates } from '../adaptive/agent-policy.mjs';
import { ResearchState, hostnameOf } from '../adaptive/research-state.mjs';

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

async function observeRerank({ state, query, providers, signal }) {
  if (!providers?.rerank || state.candidates.size === 0) return;
  const documents = [...state.candidates.values()].map((source) => ({
    id: source.id,
    text: [source.title, source.snippet, source.summary].filter(Boolean).join('\n'),
  }));
  const result = await providers.rerank.rerank({ query, documents, signal });
  for (const item of result.items) {
    const candidate = state.candidates.get(item.id);
    if (candidate) candidate.rerank = { score: item.score, provider: result.provider, degraded: result.degraded };
  }
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

export async function runAdaptiveV2(context) {
  const { query, llm, search, signal, emit, settings, budget, queryMemory, trace, researchProviders } = context;
  const exploratory = resolveExploratorySettings(settings);
  const focused = resolveFocusedSettings(settings);
  const state = new ResearchState({ query, maxSteps: exploratory.maxSteps });
  const maxReads = Math.max(1, Number(exploratory.maxReadsPerStep) || 3);
  const maxRetries = Math.max(0, Number(exploratory.maxEvaluationRetries) || 0);
  const maxOpenGaps = Number(exploratory.maxOpenGaps) || 8;
  const maxQueriesPerStep = Math.max(1, Number(exploratory.maxQueriesPerStep) || 3);
  const autoReadTopK = Math.min(Math.max(0, Number(exploratory.autoReadTopK ?? 2)), maxReads);
  const answerGateEnabled = exploratory.answerGate !== false;
  let degraded = false;

  emit({ stage: 'assessing_query' });
  emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
  addTrace(trace, state, 'assess', { reasonCode: 'agent_loop_v2', targetGapIds: ['gap-1'] }, budget);

  async function performRead({ sourceIds, gapId, reasonCode }) {
    emit({ stage: 'enriching_sources', total: sourceIds.length });
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
      embedding: researchProviders?.embedding,
    }))[0];
    state.findings.push(finding);
    const readHostnames = [];
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      state.readSourceIds.add(id);
      const existing = state.candidates.get(id) || {};
      state.candidates.set(id, { ...existing, ...source, id, freq: existing.freq || 1 });
      state.addKnowledge({ gapId: finding.gapId, sourceId: id, learned: source.summary || source.content || source.snippet });
      const hostname = hostnameOf(source.url || id);
      if (hostname) readHostnames.push(hostname);
    }
    state.observations.push({ type: 'read_result', sourceIds, successful: (finding.sources || []).filter((source) => source.fetchStatus === 'ok').length });
    state.addDiary(`read ${sourceIds.length} source(s) (${readHostnames.join(', ') || 'unknown hosts'}) for ${finding.gapId}`);
    addTrace(trace, state, 'read', { reasonCode, targetGapIds: [finding.gapId], sourceIds, knowledgeCount: state.knowledge.length }, budget);
  }

  const subQuestions = await decomposeQuery({ llm, state, signal });
  for (const question of subQuestions) {
    if (state.gaps.length >= maxOpenGaps) break;
    const gap = state.addGap(question);
    if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
  }
  addTrace(trace, state, 'decompose', {
    reasonCode: subQuestions.length ? 'query_decomposed' : 'decompose_skipped',
    targetGapIds: state.gaps.map((gap) => gap.id),
    subQuestionCount: subQuestions.length,
  }, budget, subQuestions.length ? 'success' : 'skipped');

  try {
    while (state.step < state.maxSteps) {
      abort(signal);
      let action = await decideAdaptiveAction({ llm, state, signal });
      let invalid = state.validate(action);
      let searchQueries = [];
      if (!invalid && action.action === 'search') {
        for (const candidateQuery of normalizeSearchQueries(action, maxQueriesPerStep)) {
          const duplicate = await queryMemory?.findDuplicate?.(candidateQuery, action.gapId || 'gap-1');
          if (!duplicate) searchQueries.push(candidateQuery);
        }
        if (!searchQueries.length) invalid = 'duplicate_query';
      }
      if (invalid) {
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        state.addDiary(`${action?.action || 'unknown'} rejected (${invalid})`);
        addTrace(trace, state, action?.action || 'unknown', { reasonCode: invalid }, budget, 'rejected');
        action = fallbackAdaptiveAction(state);
        invalid = state.validate(action);
        if (invalid) action = { action: 'stop', reasonCode: invalid };
        if (action.action === 'search') searchQueries = normalizeSearchQueries(action, maxQueriesPerStep);
      }
      const stepsRemaining = state.maxSteps - state.step;
      if (stepsRemaining <= 1 && !['answer', 'stop'].includes(action.action)
        && (state.findings.length > 0 || state.candidates.size > 0)) {
        addTrace(trace, state, action.action, { reasonCode: 'forced_final_answer' }, budget, 'forced');
        action = { action: 'answer', reasonCode: 'forced_final_answer' };
      }
      state.step += 1;
      state.lastAction = action.action;
      abort(signal);

      if (action.action === 'search') {
        const gapId = action.gapId || 'gap-1';
        // Pre-trim the query list so parallel execution cannot overspend the search
        // budget; the first query keeps budget-exceeded semantics (throws).
        const allowedQueries = [];
        for (const searchQuery of searchQueries) {
          if (allowedQueries.length === 0 || !budget || budget.canClaim('searchRequests', allowedQueries.length + 1)) {
            allowedQueries.push(searchQuery);
          }
        }
        emit({ stage: 'searching', iteration: state.step, iterations: state.maxSteps, total: allowedQueries.length });
        const candidatesBefore = state.candidates.size;
        const searchResults = await Promise.all(allowedQueries.map(async (searchQuery) => {
          abort(signal);
          const results = await search.search(searchQuery, { signal });
          return { searchQuery, results };
        }));
        let totalResults = 0;
        for (const { searchQuery, results } of searchResults) {
          totalResults += results.length;
          queryMemory?.record?.({ query: searchQuery, gapId, status: results.length ? 'useful' : 'empty', results });
          state.addCandidates(results, gapId);
          addSerpKnowledge(state, results, gapId);
          state.observations.push({ type: 'search_result', query: searchQuery, resultCount: results.length });
        }
        await observeRerank({ state, query: allowedQueries[0] || query, providers: researchProviders, signal });
        state.addDiary(`searched ${allowedQueries.length} quer${allowedQueries.length === 1 ? 'y' : 'ies'}, +${state.candidates.size - candidatesBefore} candidates`);
        addTrace(trace, state, 'search', { reasonCode: action.reasonCode || 'agent_search', targetGapIds: [gapId], queryCount: allowedQueries.length, resultCount: totalResults }, budget);

        // Auto-read the top ranked unread candidates so the agent does not need a
        // dedicated decision round just to pick the obvious sources. Keep at least
        // one step free so the forced-final-answer path can still run.
        if (autoReadTopK > 0 && state.step + 1 < state.maxSteps) {
          let autoReadCount = autoReadTopK;
          while (budget && autoReadCount > 0 && !budget.canClaim('sourceReads', autoReadCount)) autoReadCount -= 1;
          const picks = autoReadCount > 0 ? pickUnreadCandidates(state, autoReadCount) : [];
          if (picks.length) {
            state.step += 1;
            state.lastAction = 'read';
            await performRead({
              sourceIds: picks.map((candidate) => candidate.id).slice(0, autoReadCount),
              gapId,
              reasonCode: 'auto_read_top_ranked',
            });
          }
        }
        continue;
      }

      if (action.action === 'read') {
        await performRead({
          sourceIds: action.sourceIds.slice(0, maxReads),
          gapId: action.gapId,
          reasonCode: action.reasonCode || 'agent_read',
        });
        continue;
      }

      if (action.action === 'reflect') {
        let gapQuestion = String(action.gapQuestion || '').trim();
        if (!gapQuestion && state.gaps.length < maxOpenGaps) {
          const suggestions = await decomposeQuery({ llm, state, signal, maxSubQuestions: 1 });
          gapQuestion = suggestions.find((question) => !state.gaps.some((gap) => gap.question === question)) || '';
        }
        if (gapQuestion && state.gaps.length < maxOpenGaps) {
          const gap = state.addGap(gapQuestion);
          if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
        }
        state.addDiary(gapQuestion ? `reflected, opened gap "${gapQuestion.slice(0, 80)}"` : 'reflected, no new gap');
        addTrace(trace, state, 'reflect', { reasonCode: action.reasonCode || 'agent_reflect', targetGapIds: state.gaps.map((gap) => gap.id) }, budget);
        continue;
      }

      if (action.action === 'answer') {
        const canRetry = state.step < state.maxSteps;
        const hasDirectEvidence = state.findings.some((finding) => (finding.sources || []).some((source) => source.fetchStatus === 'ok' || source.content || source.summary));
        if (!hasDirectEvidence && canRetry && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
          state.evaluationRetries += 1;
          state.observations.push({ type: 'evaluation', verdict: 'needs_more_evidence' });
          state.addDiary('answer rejected: missing direct evidence');
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
          continue;
        }
        if (answerGateEnabled && hasDirectEvidence && canRetry && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
          const evaluation = await evaluateAnswerReadiness({ llm, state, signal });
          if (evaluation && evaluation.pass === false) {
            state.evaluationRetries += 1;
            if (evaluation.missingAspect && state.gaps.length < maxOpenGaps) {
              const gap = state.addGap(evaluation.missingAspect);
              if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
            }
            state.observations.push({ type: 'evaluation', verdict: 'answer_gate_failed', missingAspect: evaluation.missingAspect || null });
            state.addDiary(`answer gate failed${evaluation.missingAspect ? `: ${evaluation.missingAspect.slice(0, 80)}` : ''}`);
            addTrace(trace, state, 'evaluate_report', { reasonCode: 'answer_gate_failed', missingAspect: evaluation.missingAspect || null }, budget, 'retry');
            continue;
          }
        }
        addTrace(trace, state, 'answer', { reasonCode: action.reasonCode || 'agent_evidence_sufficient' }, budget);
        break;
      }

      addTrace(trace, state, 'stop', { reasonCode: action.reasonCode || 'agent_stop' }, budget);
      break;
    }
  } catch (error) {
    if (error?.name !== 'BudgetExceededError') throw error;
    degraded = true;
    addTrace(trace, state, 'stop', { reasonCode: 'budget_exhausted', kind: error.kind }, budget, 'budget_exhausted');
  }

  if (state.findings.length === 0 && state.candidates.size > 0) {
    const fallbackFinding = selectedFinding(state, [...state.candidates.keys()], 'gap-1');
    fallbackFinding.degraded = true;
    state.findings.push(fallbackFinding);
  }
  if (degraded) {
    for (const finding of state.findings) finding.degraded = true;
  }
  emit({ stage: 'research_stopped', reason: state.step >= state.maxSteps ? 'max_steps' : 'agent_answer' });
  return state.findings;
}
