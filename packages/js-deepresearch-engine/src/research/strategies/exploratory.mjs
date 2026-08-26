import { runAdaptiveV2 } from './adaptive-v2.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题；未到 token 下限就继续探索，上限或步数安全阀才截断。',
  descriptionEn: 'Explores until a token floor is met, then may stop on sufficient evidence; a high token ceiling and maxSteps are hard stops.',
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
