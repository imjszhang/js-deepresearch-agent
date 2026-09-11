import crypto from 'node:crypto';
import { loadNamedCheckpoint, recorderOrNoop } from './run-recorder.mjs';
import { SearchHealth } from '../search/search-health.mjs';
import { attachSearchMeta, getSearchMeta } from '../search/search-result.mjs';

function limit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export class BudgetExceededError extends Error {
  constructor(kind, requiredAmount = 1) {
    super(`Research budget exhausted: ${kind}`);
    this.name = 'BudgetExceededError';
    this.kind = kind;
    this.requiredAmount = Math.max(1, Number(requiredAmount) || 1);
  }
}

function purposeBucket(purpose, report = false) {
  if (report || purpose === 'report') return 'reportTokens';
  if (['claim_entailment', 'claim_validation', 'narrative_validation'].includes(purpose)) return 'postReportEvaluationTokens';
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
    this.controllerStopDetail = null;
    this.controllerStopRequiredAmount = null;
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
    this.reservations = new Map();
    this.settledAttemptIds = new Set();
    this.executionVersion = 1;
    this.onChange = null;
    this.emit = emit;
  }

  setControllerStopReason(reason, detail = null, requiredAmount = null) {
    this.controllerStopReason = reason || null;
    this.controllerStopDetail = detail || null;
    this.controllerStopRequiredAmount = Number.isFinite(requiredAmount) ? requiredAmount : null;
  }

  exhaustionDetail({ llmClaim = 1 } = {}) {
    const exploration = this.explorationUsed();
    if (this.limits.totalLlmTokens > 0
      && (this.usage.llmTokens || 0) + llmClaim > this.limits.totalLlmTokens) return 'total_llm_cap';
    if (this.limits.llmTokens > 0 && exploration + llmClaim > this.limits.llmTokens) return 'llm_hard_cap';
    if (this.limits.searchRequests > 0 && !this.canClaim('searchRequests')) return 'search_request_cap';
    if (this.limits.sourceReads > 0 && !this.canClaim('sourceReads')) return 'source_read_cap';
    return null;
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
    return Math.max(0, this.limits.llmTokens - this.explorationUsed() - this.reservedTokens('explorationTokens'));
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
      throw new BudgetExceededError(kind, amount);
    }
    this.usage[kind] = (this.usage[kind] || 0) + amount;
    if (kind === 'llmTokens') {
      const bucket = purposeBucket(options.purpose, options.report);
      this.usage[bucket] = (this.usage[bucket] || 0) + amount;
      if (isEvaluationBucket(bucket)) {
        this.usage.evaluationTokens = (this.usage.evaluationTokens || 0) + amount;
      }
    }
    this.onChange?.();
  }

  revertLlmClaim(amount, options = {}) {
    this.usage.llmTokens = Math.max(0, (this.usage.llmTokens || 0) - amount);
    const bucket = purposeBucket(options.purpose, options.report);
    this.usage[bucket] = Math.max(0, (this.usage[bucket] || 0) - amount);
    if (isEvaluationBucket(bucket)) {
      this.usage.evaluationTokens = Math.max(0, (this.usage.evaluationTokens || 0) - amount);
    }
  }

  reservedTokens(bucket = null) {
    return [...this.reservations.values()].filter((entry) => !bucket || entry.bucket === bucket).reduce((sum, entry) => sum + entry.amount, 0);
  }

  reserveAttempt(attemptId, amount, options = {}) {
    if (this.reservations.has(attemptId) || this.settledAttemptIds.has(attemptId)) throw new Error('Attempt already accounted.');
    if (!this.canClaim('llmTokens', amount, options)) throw new BudgetExceededError('llmTokens', amount);
    this.reservations.set(attemptId, { attemptId, amount, bucket: purposeBucket(options.purpose, options.report),
      purpose: options.purpose, report: Boolean(options.report), status: 'pending' });
    this.onChange?.();
  }

  settleAttempt(attemptId, usage) {
    if (this.settledAttemptIds.has(attemptId)) return false;
    const reservation = this.reservations.get(attemptId);
    if (!reservation) return false;
    const tokens = Number(usage?.totalTokens ?? usage?.total_tokens);
    if (Number.isFinite(tokens) && tokens >= 0) {
      this.reservations.delete(attemptId);
      this.recordLlmUsage(usage, reservation);
      this.settledAttemptIds.add(attemptId);
      if (this.executionVersion === 2) {
        for (const bucket of ['explorationTokens', 'reportTokens', 'candidateEvaluationTokens', 'postReportEvaluationTokens']) {
          this.unknown[bucket] = Boolean(this.legacyUsageUnknown) || [...this.reservations.values()].some((entry) => entry.bucket === bucket && entry.status === 'outcome_unknown');
        }
        this.unknown.llmTokens = Boolean(this.legacyUsageUnknown) || [...this.reservations.values()].some((entry) => entry.status === 'outcome_unknown');
      }
    } else {
      reservation.status = 'outcome_unknown';
      this.unknown.llmTokens = true;
      this.unknown[reservation.bucket] = true;
    }
    this.onChange?.();
    return true;
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
      if (this.limits.totalLlmTokens > 0 && (this.usage.llmTokens || 0) + this.reservedTokens() + amount > this.limits.totalLlmTokens) {
        return false;
      }
      if (this.isReportClaim(options)) return true;
      const bucket = purposeBucket(options.purpose, options.report);
      if (bucket === 'postReportEvaluationTokens') {
        const cap = this.limits.postReportEvaluationTokens || 0;
        return cap === 0 || (this.usage.postReportEvaluationTokens || 0) + this.reservedTokens(bucket) + amount <= cap;
      }
      if (bucket === 'candidateEvaluationTokens') {
        const cap = this.limits.candidateEvaluationTokens || 0;
        return cap === 0 || (this.usage.candidateEvaluationTokens || 0) + this.reservedTokens(bucket) + amount <= cap;
      }
      const cap = this.limits.llmTokens || 0;
      if (cap === 0) return true;
      return this.explorationUsed() + this.reservedTokens(bucket) + amount <= cap;
    }
    const cap = this.limits[kind] || 0;
    if (cap === 0) return true;
    return (this.usage[kind] || 0) + amount <= cap;
  }

  snapshot() {
    return {
      executionVersion: this.executionVersion,
      legacyUsageUnknown: Boolean(this.legacyUsageUnknown),
      reservations: [...this.reservations.values()],
      settledAttemptIds: [...this.settledAttemptIds],
      // Confirmed usage is a lower bound even when another attempt is unknown.
      // The unknown reservation still constrains the ceiling independently.
      floorStatus: this.executionVersion === 2 && this.explorationUsed() >= this.minLlmTokens ? 'met'
        : (this.executionVersion === 2 ? this.unknown.explorationTokens : this.unknown.llmTokens) ? 'unknown'
        : this.explorationUsed() >= this.minLlmTokens ? 'met' : 'unmet',
      floorShortfallTokens: Math.max(0, this.minLlmTokens - this.explorationUsed()),
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
      controllerStopDetail: this.controllerStopDetail,
      controllerStopRequiredAmount: this.controllerStopRequiredAmount,
      usage: { ...this.usage },
      unknown: { ...this.unknown },
      stopReason: this.stopReason,
    };
  }

  exportCheckpoint() {
    return {
      ...this.snapshot(),
      defaultLlmMaxTokens: this.defaultLlmMaxTokens,
      exhaustedKinds: [...this.exhaustedKinds],
    };
  }

  restoreCheckpoint(checkpoint = {}) {
    this.executionVersion = checkpoint.executionVersion || 1;
    this.legacyUsageUnknown = Boolean(checkpoint.legacyUsageUnknown);
    this.reservations = new Map((checkpoint.reservations || []).map((entry) => [entry.attemptId, entry]));
    this.settledAttemptIds = new Set(checkpoint.settledAttemptIds || []);
    if (checkpoint.limits) this.limits = { ...this.limits, ...checkpoint.limits };
    if (checkpoint.usage) this.usage = { ...this.usage, ...checkpoint.usage };
    if (checkpoint.unknown) this.unknown = { ...this.unknown, ...checkpoint.unknown };
    this.maxReportOutputTokens = Number(checkpoint.maxReportOutputTokens) || 0;
    this.estimatedReportPromptTokens = Number(checkpoint.estimatedReportPromptTokens) || 0;
    this.minLlmTokens = Number(checkpoint.minLlmTokens) || 0;
    this.targetLlmTokens = Number(checkpoint.targetLlmTokens) || this.minLlmTokens;
    this.controllerStopReason = checkpoint.controllerStopReason || null;
    this.controllerStopDetail = checkpoint.controllerStopDetail || null;
    this.controllerStopRequiredAmount = Number.isFinite(checkpoint.controllerStopRequiredAmount)
      ? checkpoint.controllerStopRequiredAmount
      : null;
    this.defaultLlmMaxTokens = Number(checkpoint.defaultLlmMaxTokens) || this.defaultLlmMaxTokens;
    this.stopReason = checkpoint.stopReason || null;
    this.exhaustedKinds = new Set(checkpoint.exhaustedKinds || []);
    return this;
  }
}

export function wrapProvidersWithBudget({
  llm,
  search,
  budget,
  onLlmEvent = () => {},
  recorder: providedRecorder,
  llmCallSequence = 0,
  searchCallSequence = 0,
}) {
  const recorder = recorderOrNoop(providedRecorder);
  if (budget.executionVersion === 2) budget.onChange = () => recorder.checkpoint('budget-ledger', { budget: budget.exportCheckpoint() });
  let llmSeq = Number(llmCallSequence) || 0;
  let searchSeq = Number(searchCallSequence) || 0;
  let lastLlmCall = null;
  const savedHealth = budget.executionVersion === 2 && recorder.sessionDir
    ? loadNamedCheckpoint(recorder.sessionDir, 'search-health')?.state : null;
  let prefetched = savedHealth?.prefetched || null;
  if (savedHealth?.channels) search.restoreSearchHealthState?.(savedHealth.channels);
  const saveHealth = snapshot => recorder.checkpoint('search-health', { health: snapshot, prefetched,
    channels: search.getSearchHealthState?.() || null, budget: budget.exportCheckpoint() });
  const health = budget.executionVersion === 2 ? new SearchHealth({ snapshot: savedHealth?.health, onChange: saveHealth }) : null;
  const searchKey = (query, options) => JSON.stringify([query, options?.searchOptions || {}]);
  return {
    llm: {
      ...llm,
      getLastCallMetadata() { return lastLlmCall ? { ...lastLlmCall } : null; },
      async complete(args) {
        const callId = `llm-${++llmSeq}`;
        const purpose = args?.purpose || 'unspecified';
        const startedAt = Date.now();
        onLlmEvent({ status: 'started', callId, purpose });
        try {
          const recordedRequest = typeof llm.buildRecordedRequest === 'function'
            ? llm.buildRecordedRequest(args)
            : {
              provider: llm.provider || 'custom',
              model: llm.model || null,
              body: {
                messages: args?.messages || [],
                temperature: args?.temperature,
                maxTokens: args?.maxTokens,
                reasoningEffort: args?.reasoningEffort,
              },
            };
          const recovered = budget.executionVersion === 2 ? recorder.recoverCall?.('llm', recordedRequest, purpose) : null;
          if (recovered) {
            budget.settleAttempt(recovered.callId, recovered.response.usage);
            lastLlmCall = { callId: recovered.callId, purpose, status: 'completed', recovered: true };
            onLlmEvent(lastLlmCall);
            return String(recovered.response.text || '');
          }
          const requested = Number(args?.maxTokens);
          const isReport = purpose === 'report';
          const claimAmount = Number.isFinite(requested) && requested > 0
            ? requested
            : (isReport ? 1 : (budget.limits.llmTokens > 0 ? budget.defaultLlmMaxTokens : 1));
          if (budget.executionVersion === 2) {
            const promptBound = Buffer.byteLength(JSON.stringify(args?.messages || []), 'utf8');
            if (isReport && !(requested > 0) && budget.limits.totalLlmTokens > 0) {
              const error = new Error('A finite total budget requires a finite report output limit.');
              error.code = 'INVALID_REPORT_BUDGET_CONFIGURATION'; throw error;
            }
            budget.reserveAttempt(callId, claimAmount + promptBound, { purpose, report: isReport });
          } else budget.claim('llmTokens', claimAmount, { purpose, report: isReport });
          budget.usage.llmRequests += 1;
          budget.onChange?.();
          const recordedMessages = recordedRequest?.body?.messages || args?.messages || [];
          const promptText = JSON.stringify(recordedMessages);
          const requestMetadata = {
            purpose,
            attempt: args?.attempt ?? null,
            timeoutMs: args?.timeoutMs
              ?? llm.transportOptions?.headersTimeoutMs
              ?? llm.config?.timeoutMs
              ?? null,
            transport: llm.transportOptions || null,
            promptChars: promptText.length,
            promptSha256: crypto.createHash('sha256').update(promptText).digest('hex'),
          };
          recorder.callStarted({
            callId,
            kind: 'llm',
            ...requestMetadata,
            request: recordedRequest,
          });
          if (purpose === 'report') {
            recorder.checkpoint('report-request-ready', {
              callId,
              request: recordedRequest,
              budget: budget.exportCheckpoint(),
            }, requestMetadata);
          }
          const result = typeof llm.completeWithMetadata === 'function'
            ? await llm.completeWithMetadata(args)
            : await llm.complete(args);
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
          recorder.callFinished({
            callId,
            kind: 'llm',
            purpose,
            status: 'completed',
            response: {
              text: String(text || ''),
              usage: result?.usage || null,
              finishReason: lastLlmCall.finishReason,
              metadata: result?.metadata || null,
            },
            durationMs: lastLlmCall.durationMs,
          });
          if (budget.executionVersion === 2) {
            budget.settleAttempt(callId, result?.usage);
          } else if (result?.usage) {
            budget.revertLlmClaim(claimAmount, { purpose, report: isReport });
            budget.recordLlmUsage(result.usage, { purpose, report: isReport });
          } else {
            budget.unknown.llmTokens = true;
          }
          onLlmEvent(lastLlmCall);
          return String(text || '');
        } catch (error) {
          if (budget.executionVersion === 2 && budget.reservations.has(callId)) budget.settleAttempt(callId, null);
          lastLlmCall = {
            status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
            callId,
            purpose,
            durationMs: Date.now() - startedAt,
            errorName: error?.name || 'Error',
            errorCode: error?.code || null,
          };
          recorder.callFinished({
            callId,
            kind: 'llm',
            purpose,
            status: lastLlmCall.status,
            error,
            durationMs: lastLlmCall.durationMs,
          });
          onLlmEvent(lastLlmCall);
          throw error;
        }
      },
    },
    search: {
      ...search,
      capabilities: search.capabilities,
      healthSnapshot: () => health?.snapshot() || null,
      async ensureReady(query, { signal } = {}) {
        if (!search.requiresReadinessProbe || !health) return;
        prefetched = null;
        health.beginProbe();
        search.beginReadinessProbe?.();
        const options = { signal, healthProbe: true };
        const result = await this.search(query, options);
        prefetched = { key: searchKey(query, options), result, meta: getSearchMeta(result) };
        saveHealth(health.snapshot());
      },
      async search(query, options) {
        health?.assertAvailable();
        if (prefetched?.key === searchKey(query, options)) {
          const cached = prefetched; prefetched = null;
          saveHealth(health.snapshot());
          return attachSearchMeta(cached.result, cached.meta || {});
        }
        const request = { provider: search.id || search.provider || 'search', query, options: { ...(options || {}), signal: undefined } };
        const recovered = budget.executionVersion === 2 && !options?.healthProbe ? recorder.recoverCall?.('search', request) : null;
        if (recovered) return recovered.response;
        budget.claim('searchRequests');
        const callId = `search-${++searchSeq}`;
        const startedAt = Date.now();
        recorder.callStarted({
          callId,
          kind: 'search',
          request: {
            provider: search.id || search.provider || 'search',
            query,
            options: {
              ...(options || {}),
              signal: undefined,
            },
          },
        });
        try {
          let result;
          try { result = await search.search(query, options); }
          catch (error) { if (health) health.fail(error); throw error; }
          recorder.callFinished({
            callId,
            kind: 'search',
            status: 'completed',
            response: result,
            durationMs: Date.now() - startedAt,
          });
          health?.succeed();
          return result;
        } catch (error) {
          recorder.callFinished({
            callId,
            kind: 'search',
            status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
            error,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    },
  };
}
