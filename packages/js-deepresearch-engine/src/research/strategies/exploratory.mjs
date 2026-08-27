import { runAdaptiveV2 } from './adaptive-v2.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题。token 下限只约束必须继续探索，不能单独结束；evidence_sufficient 必须通过确定性证据门槛。搜索/阅读次数和步数默认不限制；仅在探索性与全局 token 上限都关闭时用步数安全阀防死循环。',
  descriptionEn: 'Explores complex or multi-subject questions. The token floor is a keep-exploring bound, not a stop. evidence_sufficient is a deterministic readiness gate. Search/read counts and maxSteps default to unlimited. A step safety valve applies only when both token ceilings are off.',
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
      if (current) return `Enriching sources for step ${current}`;
      return 'Enriching sources';
    },
    searchStartMessage: ({ total, step, maxSteps }) => {
      if (step && maxSteps) return `Running ${total || 0} searches for step ${step}/${maxSteps}`;
      if (step) return `Running ${total || 0} searches for step ${step}`;
      return `Running ${total || 0} searches`;
    },
  },
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runExploratory(context) {
  return runAdaptiveV2(context);
}
