import { formatSourcesForQuestionContext, generatePlannedQuestions, userQueryEntry } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { inferEvidenceScope } from '../adaptive/source-policy.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';
import { buildExecutedSearchTrace } from '../search-trace.mjs';
import { buildPlannerFeedback } from '../planner-feedback.mjs';

/**
 * Shared iterative research pipeline used by multi-round quick research.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 */
export async function runIterativeStrategy(context) {
  const {
    query,
    iterations,
    questionCount,
    concurrency,
    llm,
    search,
    signal,
    emit,
    queryMemory,
    settings,
    brief,
    trace = [],
  } = context;
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, questionCount + 1);
  const findings = [];
  const searchOutcomes = [];
  const rejectedQueries = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const priorContext = iteration === 1 ? '' : formatSourcesForQuestionContext(findings);
    emit({
      stage: 'generating_questions',
      iteration,
      iterations,
    });
    const feedback = buildPlannerFeedback({
      searchedQueries: findings.map((finding) => finding.searchQuery || finding.question).filter(Boolean),
      rejectedQueries,
      recentSearchOutcomes: searchOutcomes,
      queryMemoryEntries: queryMemory?.entries || [],
    });
    const planned = await generatePlannedQuestions({
      llm,
      query,
      count: questionCount,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context: priorContext,
      brief,
      evidenceScope: inferEvidenceScope(settings),
      ...feedback,
      queryMemory,
    });

    const iterationQuestions = iteration === 1 ? [userQueryEntry(query), ...planned] : planned;
    if (Array.isArray(trace)) {
      trace.push({
        step: trace.length + 1,
        action: 'search_query_planned',
        reasonCode: iteration === 1 ? 'search_query_initial' : 'search_query_followup',
        queries: iterationQuestions.map((item) => item.query),
        queryOrigin: iteration === 1 ? 'user_query' : 'llm_planner',
        plannedQueries: iterationQuestions,
        createdAt: new Date().toISOString(),
      });
    }
    emit({
      stage: 'searching',
      iteration,
      iterations,
      total: uniqueQuestionCount(iterationQuestions.map((item) => item.query)),
    });
    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency: resolvedConcurrency,
      queryMemory,
      onSkip: ({ question }) => emit({ stage: 'query_skipped_duplicate', question, iteration, iterations }),
      onResult: (result) => {
        const executed = result.searchQuery || result.question;
        const origin = iteration === 1 && executed === query ? 'user_query' : 'llm_planner';
        searchOutcomes.push({
          query: executed,
          outcome: result.error ? 'failed' : (result.skipped || (result.sources?.length ? 'useful' : 'empty')),
          resultCount: result.sources?.length || 0,
          searchOptions: result.searchOptions,
          queryOrigin: origin,
        });
        if (result.skipped) rejectedQueries.push({ query: executed, reason: result.skipped });
        if (Array.isArray(trace)) {
          trace.push({
            step: trace.length + 1,
            action: 'search',
            ...buildExecutedSearchTrace({
              query: executed,
              queryOrigin: origin,
              plannerMode: 'initial',
              plannedQueries: iterationQuestions.filter((item) => item.query === executed),
              searchOptions: result.searchOptions,
              sources: result.sources,
              searchMeta: result.searchMeta,
              resultCount: result.sources?.length || 0,
              skipped: result.skipped || null,
              error: result.error,
              reasonCode: result.skipped || (result.error ? 'search_failed' : 'executed_search'),
            }),
            createdAt: new Date().toISOString(),
          });
        }
      },
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
    findings.push(...results.map((finding, index) => ({
      ...finding,
      iteration,
      queryOrigin: iteration === 1 && index === 0 ? 'user_query' : 'llm_planner',
      plannerMode: 'initial',
    })));
  }

  return findings;
}
