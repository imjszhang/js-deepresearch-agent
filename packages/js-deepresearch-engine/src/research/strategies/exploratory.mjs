import { runAdaptiveV2 } from './adaptive-v2.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题，在研究过程中动态发现并补齐缺口。',
  descriptionEn: 'Dynamically discover and close gaps for complex, open, or multi-subject questions.',
  requiresLlm: true,
  supportsIterations: false,
  supportsConcurrency: true,
  speed: 'variable',
  depth: 'deep',
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runExploratory(context) {
  return runAdaptiveV2(context);
}
