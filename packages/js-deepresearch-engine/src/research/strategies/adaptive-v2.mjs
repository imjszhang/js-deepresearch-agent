import { enrichFindings } from '../source-enricher.mjs';
import { resolveSourceBasedSettings } from '../source-based-settings.mjs';
import { decideAdaptiveAction, fallbackAdaptiveAction } from '../adaptive/agent-policy.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';

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

export async function runAdaptiveV2(context) {
  const { query, llm, search, signal, emit, settings, budget, queryMemory, trace, researchProviders } = context;
  const adaptive = settings?.research?.adaptive || {};
  const sourceBased = resolveSourceBasedSettings(settings);
  const state = new ResearchState({ query, maxSteps: adaptive.maxSteps });
  const maxReads = Math.max(1, Number(adaptive.maxReadsPerStep) || 3);
  const maxRetries = Math.max(0, Number(adaptive.maxEvaluationRetries) || 0);

  emit({ stage: 'assessing_query' });
  emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
  addTrace(trace, state, 'assess', { reasonCode: 'agent_loop_v2', targetGapIds: ['gap-1'] }, budget);

  try {
    while (state.step < state.maxSteps) {
      abort(signal);
      let action = await decideAdaptiveAction({ llm, state, signal });
      let invalid = state.validate(action);
      if (invalid) {
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        addTrace(trace, state, action?.action || 'unknown', { reasonCode: invalid }, budget, 'rejected');
        action = fallbackAdaptiveAction(state);
        invalid = state.validate(action);
        if (invalid) action = { action: 'stop', reasonCode: invalid };
      }
      state.step += 1;
      abort(signal);

      if (action.action === 'search') {
        emit({ stage: 'searching', iteration: state.step, iterations: state.maxSteps, total: 1 });
        const results = await search.search(action.query, { signal });
        queryMemory?.record?.({ query: action.query, gapId: action.gapId || 'gap-1', status: results.length ? 'useful' : 'empty', results });
        state.addCandidates(results, action.gapId || 'gap-1');
        await observeRerank({ state, query: action.query, providers: researchProviders, signal });
        state.observations.push({ type: 'search_result', query: action.query, resultCount: results.length });
        addTrace(trace, state, 'search', { reasonCode: action.reasonCode || 'agent_search', targetGapIds: [action.gapId || 'gap-1'], resultCount: results.length }, budget);
        continue;
      }

      if (action.action === 'read') {
        const sourceIds = action.sourceIds.slice(0, maxReads);
        emit({ stage: 'enriching_sources', total: sourceIds.length });
        let finding = selectedFinding(state, sourceIds, action.gapId);
        finding = (await enrichFindings([finding], {
          query,
          fetchMode: sourceBased.fetchMode,
          maxUrlsPerIteration: maxReads,
          maxUrlsTotal: maxReads,
          maxContentChars: sourceBased.maxContentChars,
          enrichConcurrency: sourceBased.enrichConcurrency,
          llm,
          signal,
          settings,
          budget,
        }))[0];
        state.findings.push(finding);
        for (const source of finding.sources || []) {
          state.readSourceIds.add(source.id || source.url);
          state.candidates.set(source.id || source.url, source);
        }
        state.observations.push({ type: 'read_result', sourceIds, successful: (finding.sources || []).filter((source) => source.fetchStatus === 'ok').length });
        addTrace(trace, state, 'read', { reasonCode: action.reasonCode || 'agent_read', targetGapIds: [finding.gapId], sourceIds }, budget);
        continue;
      }

      if (action.action === 'reflect') {
        if (action.gapQuestion && state.gaps.length < (Number(adaptive.maxOpenGaps) || 8)) {
          const gap = { id: `gap-${state.gaps.length + 1}`, question: action.gapQuestion, status: 'open', priority: 'normal' };
          state.gaps.push(gap);
          emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
        }
        addTrace(trace, state, 'reflect', { reasonCode: action.reasonCode || 'agent_reflect', targetGapIds: state.gaps.map((gap) => gap.id) }, budget);
        continue;
      }

      if (action.action === 'answer') {
        const hasDirectEvidence = state.findings.some((finding) => (finding.sources || []).some((source) => source.fetchStatus === 'ok' || source.content || source.summary));
        if (!hasDirectEvidence && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
          state.evaluationRetries += 1;
          state.observations.push({ type: 'evaluation', verdict: 'needs_more_evidence' });
          addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
          continue;
        }
        addTrace(trace, state, 'answer', { reasonCode: action.reasonCode || 'agent_evidence_sufficient' }, budget);
        break;
      }

      addTrace(trace, state, 'stop', { reasonCode: action.reasonCode || 'agent_stop' }, budget);
      break;
    }
  } catch (error) {
    if (error?.name !== 'BudgetExceededError') throw error;
    addTrace(trace, state, 'stop', { reasonCode: 'budget_exhausted', kind: error.kind }, budget, 'budget_exhausted');
  }

  if (state.findings.length === 0 && state.candidates.size > 0) {
    state.findings.push(selectedFinding(state, [...state.candidates.keys()], 'gap-1'));
  }
  emit({ stage: 'research_stopped', reason: state.step >= state.maxSteps ? 'max_steps' : 'agent_answer' });
  return state.findings;
}
