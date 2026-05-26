import { runIterativeStrategy } from './iterative.mjs';

export const parallelStrategyDefinition = {
  id: 'parallel',
  label: 'Parallel',
  description: 'Generate focused research questions and search them with higher concurrency.',
  requiresLlm: true,
  supportsIterations: true,
  supportsConcurrency: true,
  speed: 'fast',
  depth: 'broad',
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runParallel(context) {
  return runIterativeStrategy(context, {
    generatingMessage: (iteration, total) => `Generating parallel questions for iteration ${iteration}/${total}`,
    searchingMessage: (iteration, total, questionCount) => (
      `Running ${questionCount} parallel searches`
    ),
    searchProgressMessage: (completed, total, iteration) => (
      `Completed ${completed}/${total} parallel searches for iteration ${iteration}`
    ),
  });
}
