import { formatSourcesForQuestionContext, generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';

/**
 * Shared iterative research pipeline used by source-based and parallel strategies.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 * @param {Object} options
 * @param {(iteration: number, iterations: number) => string} options.generatingMessage
 * @param {(iteration: number, iterations: number, questionCount: number) => string} options.searchingMessage
 * @param {(completed: number, total: number, iteration: number) => string} options.searchProgressMessage
 */
export async function runIterativeStrategy(context, {
  generatingMessage,
  searchingMessage,
  searchProgressMessage,
}) {
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
    const progressBase = 10 + Math.round(((iteration - 1) / iterations) * 60);
    const priorContext = iteration === 1 ? '' : formatSourcesForQuestionContext(findings);
    emit(generatingMessage(iteration, iterations), progressBase);
    const questions = await generateQuestions({
      llm,
      query,
      count: questionCount,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context: priorContext,
    });

    const iterationQuestions = iteration === 1 ? [query, ...questions] : questions;
    emit(
      searchingMessage(iteration, iterations, uniqueQuestionCount(iterationQuestions)),
      progressBase + 5,
    );
    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency: resolvedConcurrency,
      onProgress: ({ completed, total }) => {
        const searchProgress = progressBase + 5 + Math.round((completed / total) * (50 / iterations));
        emit(searchProgressMessage(completed, total, iteration), searchProgress);
      },
    });
    findings.push(...results.map((finding) => ({ ...finding, iteration })));
  }

  return findings;
}
