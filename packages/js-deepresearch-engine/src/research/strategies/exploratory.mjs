import { runExploratoryLoop } from './exploratory-loop.mjs';

export const exploratoryStrategyDefinition = {
  id: 'exploratory',
  label: '探索性调研',
  labelEn: 'Exploratory research',
  description: '适合复杂、开放或多主体问题。Token 下限只是继续探索的地板，不是停点；只有确定性证据门槛通过才能以 evidence_sufficient 结束。gate 未通过且额度还在时必须继续 Search-Read-Reason。搜索/阅读次数和步数默认不限制；预算或步数用尽时仍写报告并列出未关闭 gap。',
  descriptionEn: 'Explores complex or multi-subject questions. The token floor is a keep-exploring bound, not a stop. evidence_sufficient comes only from a deterministic readiness gate. If the gate fails and exploration budget remains, the loop must keep searching and reading. Search/read counts and maxSteps default to unlimited. Budget or safety-cap stops still write a report with unresolved gaps.',
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
  return runExploratoryLoop(context);
}
