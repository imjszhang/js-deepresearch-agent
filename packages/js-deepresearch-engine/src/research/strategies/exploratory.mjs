import { runAdaptiveV2 } from './adaptive-v2.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题，在给定 LLM token 预算内动态发现并补齐缺口。',
  descriptionEn: 'Budget-driven exploration that dynamically discovers and closes gaps for complex, open, or multi-subject questions.',
  requiresLlm: true,
  supportsIterations: false,
  supportsConcurrency: true,
  speed: 'variable',
  depth: 'deep',
  progressProfile: {
    enrichingSourcesMessage: ({ step, maxSteps, iteration, iterations }) => {
      const current = step ?? iteration;
      const total = maxSteps ?? iterations;
      if (current && total) return `Enriching sources for step ${current}/${total}`;
      return 'Enriching sources';
    },
    searchStartMessage: ({ total, step, maxSteps }) => {
      if (step && maxSteps) return `Running ${total || 0} searches for step ${step}/${maxSteps}`;
      return `Running ${total || 0} searches`;
    },
  },
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runExploratory(context) {
  return runAdaptiveV2(context);
}
