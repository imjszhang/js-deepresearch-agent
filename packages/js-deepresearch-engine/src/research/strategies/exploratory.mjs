import { runAdaptiveV2 } from './adaptive-v2.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题。Token 下限只是继续探索的地板，不是停点；只有确定性证据门槛通过才能以 evidence_sufficient 结束。搜索/阅读次数和步数默认不限制；预算耗尽或来源阻塞时仍写报告并列出未关闭 gap。',
  descriptionEn: 'Explores complex or multi-subject questions. The token floor is a keep-exploring bound, not a stop. evidence_sufficient comes only from a deterministic readiness gate. Search/read counts and maxSteps default to unlimited. Budget or source stops still write a report with unresolved gaps.',
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
