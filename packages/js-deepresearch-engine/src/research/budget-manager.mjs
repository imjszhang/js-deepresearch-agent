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

function purposeBucket(purpose, report = false) {
  if (report || purpose === 'report') return 'reportTokens';
  if (purpose === 'claim_entailment') return 'postReportEvaluationTokens';
  if (purpose === 'answer_evaluation') return 'candidateEvaluationTokens';
  return 'explorationTokens';
}

function isEvaluationBucket(bucket) {
  return bucket === 'candidateEvaluationTokens' || bucket === 'postReportEvaluationTokens' || bucket === 'evaluationTokens';
}

export class BudgetManager {
  constructor(settings = {}, emit = () => {}) {
    const budget = settings?.research?.budget || {};
    const report = settings?.research?.report || {};
    this.limits = {
      llmTokens: limit(budget.maxLlmTokens),
      totalLlmTokens: limit(budget.maxTotalLlmTokens),
      searchRequests: limit(budget.maxSearchRequests),
      sourceReads: limit(budget.maxSourceReads),
      rerankRequests: limit(budget.maxRerankRequests),
      rerankTokens: limit(budget.maxRerankTokens),
      estimatedCost: limit(budget.maxEstimatedCost),
      candidateEvaluationTokens: limit(budget.maxCandidateEvaluationTokens),
      postReportEvaluationTokens: limit(budget.maxPostReportEvaluationTokens),
    };
    this.maxReportOutputTokens = limit(report.maxOutputTokens);
    this.reserveReportTokens = 0;
    this.estimatedReportPromptTokens = 0;
    this.reservedReportTotalTokens = 0;
    this.minLlmTokens = limit(
      settings?.research?.exploratory?.minLlmTokens ?? settings?.research?.exploratory?.targetLlmTokens,
    );
    this.targetLlmTokens = this.minLlmTokens;
    this.controllerStopReason = null;
    this.defaultLlmMaxTokens = limit(settings?.llm?.maxTokens) || 4000;
    this.usage = {
      llmRequests: 0,
      llmTokens: 0,
      explorationTokens: 0,
      reportTokens: 0,
      evaluationTokens: 0,
      candidateEvaluationTokens: 0,
      postReportEvaluationTokens: 0,
      searchRequests: 0,
      sourceReads: 0,
      rerankRequests: 0,
      rerankTokens: 0,
      estimatedCost: 0,
    };
    this.unknown = { llmTokens: false, rerankTokens: false, estimatedCost: false };
    this.stopReason = null;
    this.exhaustedKinds = new Set();
    this.emit = emit;
  }

  setControllerStopReason(reason) {
    this.controllerStopReason = reason || null;
  }

  updateReportReserve() {
    this.reserveReportTokens = 0;
    this.reservedReportTotalTokens = 0;
    return 0;
  }

  reportReserveTotal() {
    return 0;
  }

  explorationUsed() {
    const exploration = this.usage.explorationTokens || 0;
    const report = this.usage.reportTokens || 0;
    const candidate = this.usage.candidateEvaluationTokens || 0;
    const post = this.usage.postReportEvaluationTokens || 0;
    const combinedEval = this.usage.evaluationTokens || 0;
    if (exploration > 0 || report > 0 || candidate > 0 || post > 0 || combinedEval > 0) {
      return exploration;
    }
    return Math.max(0, (this.usage.llmTokens || 0) - report - candidate - post - combinedEval);
  }

  remainingVsHardCap() {
    if (!this.limits.llmTokens) return null;
    return Math.max(0, this.limits.llmTokens - this.explorationUsed());
  }

  remainingVsMin() {
    if (!this.minLlmTokens) return null;
    return Math.max(0, this.minLlmTokens - this.explorationUsed());
  }

  remainingVsTarget() {
    return this.remainingVsMin();
  }

  unusedBudgetTokens() {
    if (this.limits.llmTokens > 0) return this.remainingVsHardCap();
    return this.remainingVsMin();
  }

  isReportClaim(options = {}) {
    return options.report === true || options.purpose === 'report';
  }

  claim(kind, amount = 1, options = {}) {
    if (!this.canClaim(kind, amount, options)) {
      this.markExhausted(kind);
      throw new BudgetExceededError(kind);
    }
    this.usage[kind] = (this.usage[kind] || 0) + amount;
    if (kind === 'llmTokens') {
      const bucket = purposeBucket(options.purpose, options.report);
      this.usage[bucket] = (this.usage[bucket] || 0) + amount;
      if (isEvaluationBucket(bucket)) {
        this.usage.evaluationTokens = (this.usage.evaluationTokens || 0) + amount;
      }
    }
  }

  revertLlmClaim(amount, options = {}) {
    this.usage.llmTokens = Math.max(0, (this.usage.llmTokens || 0) - amount);
    const bucket = purposeBucket(options.purpose, options.report);
    this.usage[bucket] = Math.max(0, (this.usage[bucket] || 0) - amount);
    if (isEvaluationBucket(bucket)) {
      this.usage.evaluationTokens = Math.max(0, (this.usage.evaluationTokens || 0) - amount);
    }
  }

  markExhausted(kind) {
    this.stopReason = kind;
    if (this.exhaustedKinds.has(kind)) return;
    this.exhaustedKinds.add(kind);
    this.emit({ stage: 'budget_exhausted', kind });
  }

  recordLlmUsage(usage, options = {}) {
    const tokens = Number(usage?.totalTokens ?? usage?.total_tokens);
    if (Number.isFinite(tokens)) {
      this.usage.llmTokens += tokens;
      const bucket = purposeBucket(options.purpose, options.report);
      this.usage[bucket] = (this.usage[bucket] || 0) + tokens;
      if (isEvaluationBucket(bucket)) {
        this.usage.evaluationTokens = (this.usage.evaluationTokens || 0) + tokens;
      }
    } else this.unknown.llmTokens = true;
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

  canClaim(kind, amount = 1, options = {}) {
    if (kind === 'llmTokens') {
      if (this.limits.totalLlmTokens > 0 && (this.usage.llmTokens || 0) + amount > this.limits.totalLlmTokens) {
        return false;
      }
      if (this.isReportClaim(options)) return true;
      const bucket = purposeBucket(options.purpose, options.report);
      if (bucket === 'postReportEvaluationTokens') {
        const cap = this.limits.postReportEvaluationTokens || 0;
        return cap === 0 || (this.usage.postReportEvaluationTokens || 0) + amount <= cap;
      }
      if (bucket === 'candidateEvaluationTokens') {
        const cap = this.limits.candidateEvaluationTokens || 0;
        return cap === 0 || (this.usage.candidateEvaluationTokens || 0) + amount <= cap;
      }
      const cap = this.limits.llmTokens || 0;
      if (cap === 0) return true;
      return this.explorationUsed() + amount <= cap;
    }
    const cap = this.limits[kind] || 0;
    if (cap === 0) return true;
    return (this.usage[kind] || 0) + amount <= cap;
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      reserveReportTokens: 0,
      maxReportOutputTokens: this.maxReportOutputTokens,
      estimatedReportPromptTokens: this.estimatedReportPromptTokens,
      reservedReportTotalTokens: 0,
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
          const requested = Number(args?.maxTokens);
          const isReport = purpose === 'report';
          const claimAmount = Number.isFinite(requested) && requested > 0
            ? requested
            : (isReport ? 1 : (budget.limits.llmTokens > 0 ? budget.defaultLlmMaxTokens : 1));
          budget.claim('llmTokens', claimAmount, { purpose, report: isReport });
          const result = typeof llm.completeWithMetadata === 'function'
            ? await llm.completeWithMetadata(args)
            : await llm.complete(args);
          if (result?.usage) {
            budget.revertLlmClaim(claimAmount, { purpose, report: isReport });
            budget.recordLlmUsage(result.usage, { purpose, report: isReport });
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
