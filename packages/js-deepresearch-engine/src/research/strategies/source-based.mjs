import { runIterativeStrategy } from './iterative.mjs';

export const sourceBasedStrategyDefinition = {
  id: 'source-based',
  label: 'Source Based',
  description: 'Iteratively generate source-informed questions and search with controlled concurrency.',
  requiresLlm: true,
  supportsIterations: true,
  supportsConcurrency: true,
  speed: 'balanced',
  depth: 'deep',
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runSourceBased(context) {
  return runIterativeStrategy(context, {
    generatingMessage: (iteration, total) => `Generating research questions for iteration ${iteration}/${total}`,
    searchingMessage: (iteration, total) => `Searching iteration ${iteration}/${total}`,
    searchProgressMessage: (completed, total, iteration) => (
      `Completed ${completed}/${total} searches for iteration ${iteration}`
    ),
  });
}
