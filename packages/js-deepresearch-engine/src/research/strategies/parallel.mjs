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
  return runIterativeStrategy(context, { variant: 'parallel' });
}
