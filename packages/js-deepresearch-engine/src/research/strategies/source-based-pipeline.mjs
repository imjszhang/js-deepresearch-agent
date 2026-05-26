import { generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { enrichFindings } from '../source-enricher.mjs';
import { resolveSourceBasedSettings } from '../source-based-settings.mjs';
import { formatSourcesForResearchContext } from '../source-context.mjs';
import { filterFindingsByRelevance } from '../source-relevance-filter.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';

/**
 * Source-based pipeline with optional URL enrichment and relevance filtering.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 */
export async function runSourceBasedPipeline(context) {
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
  } = context;

  const sourceBased = resolveSourceBasedSettings(settings);
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, questionCount + 1);
  const findings = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const priorContext = iteration === 1
      ? ''
      : formatSourcesForResearchContext(findings, {
          limit: sourceBased.questionContextLimit,
          charsPerSource: sourceBased.contextCharsPerSource,
        });

    emit({
      stage: 'generating_questions',
      iteration,
      iterations,
    });

    const questions = await generateQuestions({
      llm,
      query,
      count: questionCount,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context: priorContext,
    });

    const iterationQuestions = iteration === 1 ? [query, ...questions] : questions;

    emit({
      stage: 'searching',
      iteration,
      iterations,
      total: uniqueQuestionCount(iterationQuestions),
    });

    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency: resolvedConcurrency,
      onProgress: ({ completed, total }) => {
        emit({
          stage: 'search_progress',
          iteration,
          iterations,
          completed,
          total,
        });
      },
    });

    const iterationFindings = results.map((finding) => ({ ...finding, iteration }));

    if (sourceBased.fetchMode !== 'disabled') {
      emit({
        stage: 'enriching_sources',
        iteration,
        iterations,
      });

      const enriched = await enrichFindings(iterationFindings, {
        query,
        fetchMode: sourceBased.fetchMode,
        maxUrlsPerIteration: sourceBased.maxUrlsPerIteration,
        maxUrlsTotal: sourceBased.maxUrlsTotal,
        maxContentChars: sourceBased.maxContentChars,
        enrichConcurrency: sourceBased.enrichConcurrency,
        llm,
        signal,
        settings,
      });
      findings.push(...enriched);
    } else {
      findings.push(...iterationFindings);
    }
  }

  if (sourceBased.enableRelevanceFilter) {
    emit({ stage: 'filtering_sources' });
    return filterFindingsByRelevance(findings, {
      query,
      llm,
      signal,
      enabled: true,
      maxSourcesForReport: sourceBased.maxSourcesForReport,
    });
  }

  return findings;
}
