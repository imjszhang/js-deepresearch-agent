import { generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { enrichFindings } from '../source-enricher.mjs';
import { resolveSourceBasedSettings } from '../source-based-settings.mjs';
import { applySourceSelection } from '../source-candidates.mjs';
import { evaluateEvidenceSufficiency } from '../quality-gates.mjs';
import { resolveStrategyConcurrency } from '../strategy-utils.mjs';

export const adaptiveStrategyDefinition = {
  id: 'adaptive',
  label: 'Adaptive (experimental)',
  description: 'Budgeted gap-driven search, source selection, reading, and evidence evaluation.',
  requiresLlm: true,
  supportsIterations: true,
  supportsConcurrency: true,
  speed: 'variable',
  depth: 'deep',
};

function abort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Research aborted');
  error.name = 'AbortError';
  throw error;
}

function traceEvent(trace, action, fields = {}, budget = null) {
  const entry = { step: trace.length + 1, action, durationMs: 0, ...fields, budgetBefore: budget?.snapshot?.() || null, createdAt: new Date().toISOString(), _startedAt: Date.now() };
  trace?.push(entry);
  return entry;
}

function completeTrace(entry, budget, status = 'success') {
  if (!entry) return;
  entry.durationMs = Date.now() - entry._startedAt;
  delete entry._startedAt;
  entry.budgetAfter = budget?.snapshot?.() || null;
  entry.status = status;
}

export async function runAdaptive(context) {
  const { query, llm, search, signal, emit, settings, concurrency, budget, queryMemory, trace } = context;
  const adaptive = settings?.research?.adaptive || {};
  const sourceBased = resolveSourceBasedSettings(settings);
  const maxSteps = Math.max(6, Number(adaptive.maxSteps) || 12);
  const maxOpenGaps = Math.max(1, Number(adaptive.maxOpenGaps) || 8);
  const maxQueries = Math.max(1, Number(adaptive.maxQueriesPerStep) || 3);
  let steps = 0;

  abort(signal);
  emit({ stage: 'assessing_query' });
  traceEvent(trace, 'assess', { targetGapIds: ['gap-1'], reasonCode: 'initial_assessment' }, budget);
  steps += 1;

  emit({ stage: 'planning_research' });
  const planned = await generateQuestions({ llm, query, count: Math.min(maxOpenGaps - 1, maxQueries), signal, mode: 'initial' });
  const questions = [...new Set([query, ...planned])].slice(0, maxOpenGaps);
  const gaps = questions.map((question, index) => ({ id: `gap-${index + 1}`, question }));
  traceEvent(trace, 'plan', { targetGapIds: gaps.map((gap) => gap.id), reasonCode: 'orthogonal_research_gaps' }, budget);
  for (const gap of gaps) {
    emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
  }
  steps += 1;

  const findings = [];
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, Math.min(gaps.length, Number(adaptive.plannerParallelism) || 2));
  const actionsPerBatch = sourceBased.fetchMode === 'disabled' ? 3 : 4;
  for (let offset = 0; offset < gaps.length && steps + actionsPerBatch + 4 <= maxSteps; offset += maxQueries) {
    abort(signal);
    const batch = gaps.slice(offset, offset + maxQueries);
    emit({ stage: 'searching', iteration: Math.floor(offset / maxQueries) + 1, iterations: Math.ceil(gaps.length / maxQueries), total: batch.length });
    const searchTrace = traceEvent(trace, 'search', { targetGapIds: batch.map((gap) => gap.id), reasonCode: 'missing_primary_evidence', expectedInformationGain: 'high', queries: batch.map((gap) => gap.question) }, budget);
    const results = await searchQuestions({
      questions: batch.map((gap) => gap.question),
      search,
      signal,
      concurrency: resolvedConcurrency,
      queryMemory,
      onSkip: ({ question }) => emit({ stage: 'query_skipped_duplicate', question }),
    });
    completeTrace(searchTrace, budget);
    let selected = results.map((finding, index) => ({ ...finding, gapId: batch[index]?.id || null, iteration: Math.floor(offset / maxQueries) + 1 }));
    emit({ stage: 'selecting_sources', total: selected.flatMap((finding) => finding.sources || []).length });
    selected = applySourceSelection(selected, { ...sourceBased.sourceSelection, enabled: true });
    traceEvent(trace, 'select_sources', { targetGapIds: batch.map((gap) => gap.id), reasonCode: 'rank_and_diversify_sources', sourceIds: selected.flatMap((finding) => finding.sources || []).map((source) => source.id || source.url).filter(Boolean) }, budget);
    steps += 2;

    if (sourceBased.fetchMode !== 'disabled' && steps < maxSteps) {
      emit({ stage: 'enriching_sources' });
      const readTrace = traceEvent(trace, 'read', { targetGapIds: batch.map((gap) => gap.id), reasonCode: 'extract_direct_evidence' }, budget);
      selected = await enrichFindings(selected, {
        query,
        fetchMode: sourceBased.fetchMode,
        maxUrlsPerIteration: Math.min(sourceBased.maxUrlsPerIteration, Number(adaptive.maxReadsPerStep) || 3),
        maxUrlsTotal: sourceBased.maxUrlsTotal,
        maxContentChars: sourceBased.maxContentChars,
        enrichConcurrency: sourceBased.enrichConcurrency,
        llm,
        signal,
        settings,
        budget,
      });
      completeTrace(readTrace, budget);
      steps += 1;
    }

    findings.push(...selected);
    for (const finding of selected) {
      const resolved = (finding.sources || []).length > 0;
      if (resolved) emit({ stage: 'gap_resolved', gapId: finding.gapId, question: finding.question });
    }
    traceEvent(trace, 'evaluate_gap', {
      targetGapIds: selected.map((finding) => finding.gapId),
      reasonCode: selected.every((finding) => (finding.sources || []).length > 0) ? 'usable_sources_found' : 'partial_or_no_information_gain',
      statuses: selected.map((finding) => ({ gapId: finding.gapId, status: (finding.sources || []).length > 0 ? 'resolved' : 'deferred' })),
    }, budget);
    steps += 1;

    const gate = evaluateEvidenceSufficiency({ findings, iteration: 1, minIterations: 1, query });
    emit({ stage: 'evaluating_evidence', decision: gate.decision, flags: gate.flags });
    if (gate.decision === 'stop' && findings.every((finding) => (finding.sources || []).length > 0)) break;
    if (!budget?.canClaim('searchRequests')) break;
  }

  traceEvent(trace, 'draft', { targetGapIds: gaps.map((gap) => gap.id), reasonCode: steps >= maxSteps ? 'max_steps_reached' : 'research_sufficient' }, budget);
  for (const entry of trace || []) {
    if (entry._startedAt) completeTrace(entry, budget);
  }
  emit({ stage: 'research_stopped', reason: steps >= maxSteps ? 'max_steps' : 'sufficient' });
  return findings;
}
