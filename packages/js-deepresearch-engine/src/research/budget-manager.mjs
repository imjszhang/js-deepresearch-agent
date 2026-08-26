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
      rerankRequests: limit(budget.maxRerankRequests),
      rerankTokens: limit(budget.maxRerankTokens),
      estimatedCost: limit(budget.maxEstimatedCost),
    };
    this.maxReportOutputTokens = limit(budget.reserveReportTokens) || 1200;
    this.reserveReportTokens = this.maxReportOutputTokens;
    this.estimatedReportPromptTokens = 400;
    this.reservedReportTotalTokens = this.maxReportOutputTokens + this.estimatedReportPromptTokens;
    if (this.limits.llmTokens > 0) {
      this.maxReportOutputTokens = Math.min(this.maxReportOutputTokens, this.limits.llmTokens);
      this.reserveReportTokens = this.maxReportOutputTokens;
      this.reservedReportTotalTokens = Math.min(this.reservedReportTotalTokens, this.limits.llmTokens);
    }
    this.minLlmTokens = limit(
      settings?.research?.exploratory?.minLlmTokens ?? settings?.research?.exploratory?.targetLlmTokens,
    );
    this.targetLlmTokens = this.minLlmTokens;
    this.controllerStopReason = null;
    this.defaultLlmMaxTokens = limit(settings?.llm?.maxTokens) || 4000;
    this.usage = { llmRequests: 0, llmTokens: 0, searchRequests: 0, sourceReads: 0, rerankRequests: 0, rerankTokens: 0, estimatedCost: 0 };
    this.unknown = { llmTokens: false, rerankTokens: false, estimatedCost: false };
    this.stopReason = null;
    this.exhaustedKinds = new Set();
    this.emit = emit;
  }

  setControllerStopReason(reason) {
    this.controllerStopReason = reason || null;
  }

  updateReportReserve(promptTokens) {
    const estimated = Math.max(0, Number(promptTokens) || 0);
    this.estimatedReportPromptTokens = estimated;
    const desired = estimated + this.maxReportOutputTokens;
    if (this.limits.llmTokens > 0) {
      const remaining = Math.max(0, this.limits.llmTokens - (this.usage.llmTokens || 0));
      this.reservedReportTotalTokens = Math.min(desired, remaining, this.limits.llmTokens);
      this.reservedReportTotalTokens = Math.max(
        Math.min(this.maxReportOutputTokens, remaining),
        this.reservedReportTotalTokens,
      );
    } else {
      this.reservedReportTotalTokens = desired;
    }
    return this.reservedReportTotalTokens;
  }

  reportReserveTotal({ report = false } = {}) {
    if (report) return 0;
    return this.reservedReportTotalTokens || this.reserveReportTokens || 0;
  }

  remainingVsHardCap() {
    if (!this.limits.llmTokens) return null;
    return Math.max(0, this.limits.llmTokens - (this.usage.llmTokens || 0));
  }

  remainingVsMin() {
    if (!this.minLlmTokens) return null;
    return Math.max(0, this.minLlmTokens - (this.usage.llmTokens || 0));
  }

  remainingVsTarget() {
    return this.remainingVsMin();
  }

  unusedBudgetTokens() {
    if (this.limits.llmTokens > 0) return this.remainingVsHardCap();
    return this.remainingVsMin();
  }

  claim(kind, amount = 1, { report = false } = {}) {
    const cap = this.limits[kind] || 0;
    if (cap > 0) {
      const used = this.usage[kind] || 0;
      const reserve = kind === 'llmTokens' ? this.reportReserveTotal({ report }) : 0;
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

  recordRerankUsage(usage) {
    const tokens = Number(usage?.tokens ?? usage?.totalTokens ?? usage?.total_tokens);
    if (Number.isFinite(tokens)) {
      this.usage.rerankTokens += tokens;
      if (this.limits.rerankTokens > 0 && this.usage.rerankTokens >= this.limits.rerankTokens) this.markExhausted('rerankTokens');
    } else {
      this.unknown.rerankTokens = true;
    }
  }

  canClaim(kind, amount = 1, options) {
    const cap = this.limits[kind] || 0;
    if (cap === 0) return true;
    const reserve = kind === 'llmTokens' ? this.reportReserveTotal({ report: options?.report }) : 0;
    return (this.usage[kind] || 0) + amount <= Math.max(0, cap - reserve);
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      reserveReportTokens: this.reserveReportTokens,
      maxReportOutputTokens: this.maxReportOutputTokens,
      estimatedReportPromptTokens: this.estimatedReportPromptTokens,
      reservedReportTotalTokens: this.reservedReportTotalTokens,
      minLlmTokens: this.minLlmTokens || 0,
      targetLlmTokens: this.minLlmTokens || this.targetLlmTokens || 0,
      unusedBudgetTokens: this.unusedBudgetTokens(),
      unusedMinTokens: this.remainingVsMin(),
      unusedTargetTokens: this.remainingVsMin(),
      unusedHardCapTokens: this.remainingVsHardCap(),
      controllerStopReason: this.controllerStopReason,
      usage: { ...this.usage },
      unknown: { ...this.unknown },
      stopReason: this.stopReason,
    };
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
