// Frozen v1 execution fixtures cover the compatibility algorithm, including retired
// decide/report-parse behavior. New runs and v2 tests use the public runner directly.
import { ResearchRunner as CurrentResearchRunner } from '../../src/index.mjs';
import { BudgetManager } from '../../src/research/budget-manager.mjs';
import { applyExploratoryBudget, resolveExploratorySettings } from '../../src/research/exploratory-settings.mjs';

// Legacy string-only scripts historically consumed their requested allocation.
// Declare that fixed synthetic usage explicitly so format/fallback fixtures test
// their intended behavior under the new unknown-usage boundary. Providers which
// already expose metadata (including intentionally absent usage) are untouched.
export function legacyFixtureLlm(llm, settings = {}) {
  if (!llm?.complete || llm.completeWithMetadata) return llm;
  const allocation = new BudgetManager(settings);
  if (settings.research?.strategy === 'exploratory') {
    applyExploratoryBudget(allocation, resolveExploratorySettings(settings));
  }
  return {
    ...llm,
    async completeWithMetadata(args) {
      const text = await llm.complete(args);
      if (text != null && typeof text !== 'string') return text;
      const requested = Number(args?.maxTokens);
      const totalTokens = Number.isFinite(requested) && requested > 0 ? requested
        : args?.purpose === 'report' ? 1
          : allocation.limits.llmTokens > 0 ? allocation.defaultLlmMaxTokens : 1;
      return { text: text ?? '', usage: { totalTokens }, metadata: { syntheticFixtureUsage: true } };
    },
  };
}

export class ResearchRunner extends CurrentResearchRunner {
  run(options) {
    return super.run({ ...options, llm: legacyFixtureLlm(options.llm, options.settings), executionVersion: 1 });
  }
}
