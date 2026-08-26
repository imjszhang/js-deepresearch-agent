import { runFocusedPipeline } from './focused-pipeline.mjs';

export const focusedStrategyDefinition = {
  id: 'focused',
  label: '专题调研',
  labelEn: 'Focused research',
  description: '针对明确问题，阅读来源并形成有依据的报告。',
  descriptionEn: 'Read sources and produce a cited report for a well-bounded question.',
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
export async function runFocused(context) {
  return runFocusedPipeline(context);
}
