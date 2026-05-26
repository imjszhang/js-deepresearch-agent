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
  progressProfile: {
    generateQuestionsMessage: ({ iteration, iterations }) => (
      `Generating research questions for iteration ${iteration}/${iterations}`
    ),
    searchStartMessage: ({ iteration, iterations }) => `Searching iteration ${iteration}/${iterations}`,
    searchProgressMessage: ({ completed, total, iteration }) => (
      `Completed ${completed}/${total} searches for iteration ${iteration}`
    ),
  },
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runSourceBased(context) {
  return runIterativeStrategy(context);
}
