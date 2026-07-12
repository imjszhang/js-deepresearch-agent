function limit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export class BudgetExceededError extends Error {
  constructor(kind) {
    super(`Research budget exhausted: ${kind}`);
    this.name = 'BudgetExceededError';
    this.kind = kind;
  }
}

export class BudgetManager {
  constructor(settings = {}, emit = () => {}) {
    const budget = settings?.research?.budget || {};
    this.limits = {
      llmTokens: limit(budget.maxLlmTokens),
      searchRequests: limit(budget.maxSearchRequests),
      sourceReads: limit(budget.maxSourceReads),
      estimatedCost: limit(budget.maxEstimatedCost),
    };
    this.reserveReportTokens = limit(budget.reserveReportTokens) || 1200;
    if (this.limits.llmTokens > 0) this.reserveReportTokens = Math.min(this.reserveReportTokens, this.limits.llmTokens);
    this.defaultLlmMaxTokens = limit(settings?.llm?.maxTokens) || 4000;
    this.usage = { llmRequests: 0, llmTokens: 0, searchRequests: 0, sourceReads: 0, estimatedCost: 0 };
    this.unknown = { llmTokens: false, estimatedCost: false };
    this.stopReason = null;
    this.emit = emit;
  }

  claim(kind, amount = 1, { report = false } = {}) {
    const cap = this.limits[kind] || 0;
    if (cap > 0) {
      const used = this.usage[kind] || 0;
      const reserve = kind === 'llmTokens' && !report ? this.reserveReportTokens : 0;
      if (used + amount > Math.max(0, cap - reserve)) {
        this.stopReason = kind;
        this.emit({ stage: 'budget_exhausted', kind });
        throw new BudgetExceededError(kind);
      }
    }
    this.usage[kind] = (this.usage[kind] || 0) + amount;
  }

  recordLlmUsage(usage) {
    const tokens = Number(usage?.totalTokens ?? usage?.total_tokens);
    if (Number.isFinite(tokens)) this.usage.llmTokens += tokens;
    else this.unknown.llmTokens = true;
    const cost = Number(usage?.estimatedCost ?? usage?.estimated_cost);
    if (Number.isFinite(cost)) {
      this.usage.estimatedCost += cost;
      if (this.limits.estimatedCost > 0 && this.usage.estimatedCost >= this.limits.estimatedCost) {
        this.stopReason = 'estimatedCost';
        this.emit({ stage: 'budget_exhausted', kind: 'estimatedCost' });
      }
    }
    else this.unknown.estimatedCost = true;
  }

  canClaim(kind, amount = 1, options) {
    const cap = this.limits[kind] || 0;
    if (cap === 0) return true;
    const reserve = kind === 'llmTokens' && !options?.report ? this.reserveReportTokens : 0;
    return (this.usage[kind] || 0) + amount <= Math.max(0, cap - reserve);
  }

  snapshot() {
    return { limits: { ...this.limits }, reserveReportTokens: this.reserveReportTokens, usage: { ...this.usage }, unknown: { ...this.unknown }, stopReason: this.stopReason };
  }
}

export function wrapProvidersWithBudget({ llm, search, budget }) {
  return {
    llm: {
      ...llm,
      async complete(args) {
        budget.usage.llmRequests += 1;
        const requestedTokens = Number(args?.maxTokens) || (budget.limits.llmTokens > 0 ? budget.defaultLlmMaxTokens : 1);
        budget.claim('llmTokens', requestedTokens, { report: args?.purpose === 'report' });
        const result = await llm.complete(args);
        if (result?.usage) {
          budget.usage.llmTokens -= requestedTokens;
          budget.recordLlmUsage(result.usage);
        } else {
          budget.unknown.llmTokens = true;
        }
        return typeof result === 'string' ? result : (result?.text ?? result?.content ?? '');
      },
    },
    search: {
      ...search,
      capabilities: search.capabilities,
      async search(query, options) {
        budget.claim('searchRequests');
        return search.search(query, options);
      },
    },
  };
}
