import { formatSourcesForQuestionContext, generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';

/**
 * Shared iterative research pipeline used by source-based and parallel strategies.
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
  } = context;
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, questionCount + 1);
  const findings = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const priorContext = iteration === 1 ? '' : formatSourcesForQuestionContext(findings);
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
    findings.push(...results.map((finding) => ({ ...finding, iteration })));
  }

  return findings;
}
