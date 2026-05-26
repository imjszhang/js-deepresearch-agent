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
  return runIterativeStrategy(context, { variant: 'source-based' });
}
