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
    this.exhaustedKinds = new Set();
    this.emit = emit;
  }

  claim(kind, amount = 1, { report = false } = {}) {
    const cap = this.limits[kind] || 0;
    if (cap > 0) {
      const used = this.usage[kind] || 0;
      const reserve = kind === 'llmTokens' && !report ? this.reserveReportTokens : 0;
      if (used + amount > Math.max(0, cap - reserve)) {
        this.markExhausted(kind);
        throw new BudgetExceededError(kind);
      }
    }
    this.usage[kind] = (this.usage[kind] || 0) + amount;
  }

  markExhausted(kind) {
    this.stopReason = kind;
    if (this.exhaustedKinds.has(kind)) return;
    this.exhaustedKinds.add(kind);
    this.emit({ stage: 'budget_exhausted', kind });
  }

  recordLlmUsage(usage) {
    const tokens = Number(usage?.totalTokens ?? usage?.total_tokens);
    if (Number.isFinite(tokens)) this.usage.llmTokens += tokens;
    else this.unknown.llmTokens = true;
    const cost = Number(usage?.estimatedCost ?? usage?.estimated_cost);
    if (Number.isFinite(cost)) {
      this.usage.estimatedCost += cost;
      if (this.limits.estimatedCost > 0 && this.usage.estimatedCost >= this.limits.estimatedCost) {
        this.markExhausted('estimatedCost');
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

export function wrapProvidersWithBudget({ llm, search, budget, onLlmEvent = () => {} }) {
  let llmCallSequence = 0;
  let lastLlmCall = null;
  return {
    llm: {
      ...llm,
      getLastCallMetadata() { return lastLlmCall ? { ...lastLlmCall } : null; },
      async complete(args) {
        const callId = `llm-${++llmCallSequence}`;
        const purpose = args?.purpose || 'unspecified';
        const startedAt = Date.now();
        onLlmEvent({ status: 'started', callId, purpose });
        try {
          budget.usage.llmRequests += 1;
          const requestedTokens = Number(args?.maxTokens) || (budget.limits.llmTokens > 0 ? budget.defaultLlmMaxTokens : 1);
          budget.claim('llmTokens', requestedTokens, { report: purpose === 'report' });
          const result = typeof llm.completeWithMetadata === 'function'
            ? await llm.completeWithMetadata(args)
            : await llm.complete(args);
          if (result?.usage) {
            budget.usage.llmTokens -= requestedTokens;
            budget.recordLlmUsage(result.usage);
          } else {
            budget.unknown.llmTokens = true;
          }
          const text = typeof result === 'string' ? result : (result?.text ?? result?.content ?? '');
          lastLlmCall = {
            status: 'completed',
            callId,
            purpose,
            durationMs: Date.now() - startedAt,
            outputChars: String(text || '').length,
            responseType: typeof result === 'string' ? 'string' : 'object',
            responseFields: result && typeof result === 'object' ? Object.keys(result).filter((key) => !['prompt', 'messages'].includes(key)) : [],
            finishReason: result?.finishReason || result?.metadata?.finishReason || null,
            hasContent: Boolean(String(text || '').trim()),
            hasReasoningContent: Boolean(result?.metadata?.hasReasoningContent),
            providerResponseFields: Array.isArray(result?.metadata?.responseFields) ? result.metadata.responseFields : [],
          };
          onLlmEvent(lastLlmCall);
          return String(text || '');
        } catch (error) {
          lastLlmCall = {
            status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
            callId,
            purpose,
            durationMs: Date.now() - startedAt,
            errorName: error?.name || 'Error',
            errorCode: error?.code || null,
          };
          onLlmEvent(lastLlmCall);
          throw error;
        }
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
