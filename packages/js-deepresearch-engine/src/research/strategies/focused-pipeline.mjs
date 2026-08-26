import { generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { formatSourcesForResearchContext } from '../source-context.mjs';
import { filterFindingsByRelevance } from '../source-relevance-filter.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';
import { applySourceSelection } from '../source-candidates.mjs';
import { evaluateEvidenceSufficiency } from '../quality-gates.mjs';

/**
 * Focused pipeline with optional URL enrichment, source selection, and early-stop.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 */
export async function runFocusedPipeline(context) {
  const {
    query,
    iterations,
    questionCount,
    concurrency,
    llm,
    search,
    signal,
    emit,
    settings,
    budget,
    queryMemory,
    trace = [],
    researchProviders,
  } = context;

  const focused = resolveFocusedSettings(settings);
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, questionCount + 1);
  const findings = [];
  let focusedQuestions = [];

  const iterationLimit = focused.iterationControl.enabled
    ? Math.max(focused.iterationControl.minIterations, focused.iterationControl.maxIterations)
    : iterations;
  for (let iteration = 1; iteration <= iterationLimit; iteration += 1) {
    const priorContext = iteration === 1
      ? ''
      : formatSourcesForResearchContext(findings, {
          limit: focused.questionContextLimit,
          charsPerSource: focused.contextCharsPerSource,
        });

    emit({
      stage: 'generating_questions',
      iteration,
      iterations: iterationLimit,
    });

    const generatedQuestions = await generateQuestions({
      llm,
      query,
      count: questionCount,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context: priorContext,
    });
    const questions = [...focusedQuestions, ...generatedQuestions]
      .filter((question, index, all) => all.indexOf(question) === index)
      .slice(0, questionCount);

    const iterationQuestions = iteration === 1 ? [query, ...questions] : questions;

    emit({
      stage: 'searching',
      iteration,
      iterations: iterationLimit,
      total: uniqueQuestionCount(iterationQuestions),
    });

    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency: resolvedConcurrency,
      queryMemory,
      onSkip: ({ question }) => emit({ stage: 'query_skipped_duplicate', question, iteration, iterations: iterationLimit }),
      onProgress: ({ completed, total }) => {
        emit({
          stage: 'search_progress',
          iteration,
          iterations: iterationLimit,
          completed,
          total,
        });
      },
    });

    let iterationFindings = results.map((finding) => ({ ...finding, iteration }));
    iterationFindings = applySourceSelection(iterationFindings, focused.sourceSelection);

    if (focused.fetchMode !== 'disabled') {
      emit({
        stage: 'enriching_sources',
        iteration,
        iterations: iterationLimit,
      });

      const enriched = await enrichFindings(iterationFindings, {
        query,
        fetchMode: focused.fetchMode,
        maxUrlsPerIteration: focused.maxUrlsPerIteration,
        maxUrlsTotal: focused.maxUrlsTotal,
        maxContentChars: focused.maxContentChars,
        enrichConcurrency: focused.enrichConcurrency,
        llm,
        signal,
        settings,
        budget,
        embedding: researchProviders?.embedding,
      });
      findings.push(...enriched);
    } else {
      findings.push(...iterationFindings);
    }

    if (focused.iterationControl.enabled) {
      const gate = evaluateEvidenceSufficiency({
        findings,
        iteration,
        minIterations: focused.iterationControl.minIterations,
        query,
      });
      focusedQuestions = gate.recommendedQuestions;
      trace.push({
        step: trace.length + 1,
        action: 'evaluate_gap',
        reasonCode: gate.decision,
        iteration,
        flags: gate.flags,
        criticalGaps: gate.criticalGaps,
        recommendedQuestions: gate.recommendedQuestions,
        method: gate.method,
        createdAt: new Date().toISOString(),
      });
      emit({ stage: 'evaluating_evidence', iteration, iterations: iterationLimit, decision: gate.decision, flags: gate.flags });
      if (gate.decision === 'stop' && focused.iterationControl.earlyStop) break;
      if (gate.criticalGaps.length && !focused.iterationControl.continueOnCriticalGaps) break;
      if (budget && !budget.canClaim('searchRequests') && iteration < iterationLimit) break;
    }
  }

  if (focused.enableRelevanceFilter) {
    emit({ stage: 'filtering_sources' });
    return filterFindingsByRelevance(findings, {
      query,
      llm,
      signal,
      enabled: true,
      maxSourcesForReport: focused.maxSourcesForReport,
    });
  }

  return findings;
}
