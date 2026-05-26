import { runSourceBasedPipeline } from './source-based-pipeline.mjs';

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
    enrichingSourcesMessage: ({ iteration, iterations }) => (
      `Enriching sources for iteration ${iteration}/${iterations}`
    ),
    filteringSourcesMessage: () => 'Filtering sources for relevance',
  },
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runSourceBased(context) {
  return runSourceBasedPipeline(context);
}
