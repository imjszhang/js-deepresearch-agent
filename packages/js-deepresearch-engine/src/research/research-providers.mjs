import { maxRecordedCallSequence } from './run-recorder.mjs';
import { querySimilarity } from './query-memory.mjs';
import { HttpRerankProvider } from './providers/http-rerank-provider.mjs';
import { JinaRerankProvider } from './providers/jina-rerank-provider.mjs';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding-provider.mjs';
import { DisabledRerankProvider, RulesRerankProvider } from './providers/rules-rerank-provider.mjs';
import { isAbortError } from './providers/semantic-provider-errors.mjs';
import { cacheEmbedding } from './embedding-cache.mjs';
import { JevJudgeProvider, JudgeProviderError, isJudgeUnavailable, prepareJudgeState, sha256, validateJudgeAnswers } from './providers/jev-judge-provider.mjs';
import { judgeActive, resolveJudgeSettings } from './judge-settings.mjs';

export const deterministicResearchProviders = Object.freeze({
  similarity: { async similarity(left, right) { return querySimilarity(left, right); } },
  rerank: new RulesRerankProvider(),
  embedding: null,
  evidenceJudge: null,
  contentReader: null,
  freshnessResolver: { async resolve(source) { return source?.publishedAt || source?.date || null; } },
});

function withFetch(config, fetch) {
  if (!config || typeof fetch !== 'function') {
    return config;
  }
  return { ...config, fetch };
}

function resolveRerank(config, { budget, fetch } = {}) {
  config = withFetch(config, fetch);
  if (config?.rerank) return config;
  if (config?.provider === 'disabled') return new DisabledRerankProvider();
  if (!config || config.provider === 'rules' || !config.provider) {
    return new RulesRerankProvider(config);
  }
  if (config.provider === 'jina') {
    return new JinaRerankProvider(config, {
      onRequest: () => budget?.claim('rerankRequests'),
    });
  }
  if (config.provider === 'http' || config.provider === 'local') {
    return new HttpRerankProvider({ ...config, providerName: config.provider }, {
      onRequest: () => budget?.claim('rerankRequests'),
    });
  }
  throw new Error(`Unsupported rerank provider: ${config.provider}`);
}

function resolveEmbedding(config, { fetch } = {}) {
  config = withFetch(config, fetch);
  if (!config || config.provider === 'disabled') return null;
  if (['openai-compatible', 'http', 'openai', 'local'].includes(config.provider)) {
    return new OpenAiEmbeddingProvider(config);
  }
  if (config.embed || config.embedDocuments) return config;
  throw new Error(`Unsupported embedding provider: ${config.provider}`);
}

function wrapEmbedding(embedding, { onEvent, recorder, nextCallId } = {}) {
  if (!embedding) return null;
  const wrapped = {
    ...embedding,
    provider: embedding.provider,
    model: embedding.model,
    async embedDocuments(texts = [], options = {}) {
      const startedAt = Date.now();
      const purpose = options.purpose || 'embed';
      const inputCount = Array.isArray(texts) ? texts.length : 0;
      const callId = nextCallId?.('embedding') || `embedding-${Date.now()}`;
      recorder?.callStarted?.({
        callId,
        kind: 'embedding',
        purpose,
        request: {
          provider: embedding.provider || null,
          model: embedding.model || null,
          texts,
          options: { ...options, signal: undefined },
        },
      });
      onEvent?.({
        operation: 'embed',
        status: 'started',
        provider: embedding.provider || null,
        model: embedding.model || null,
        purpose,
        inputCount,
      });
      try {
        const vectors = await embedding.embedDocuments(texts, options);
        onEvent?.({
          operation: 'embed',
          status: 'completed',
          provider: embedding.provider || null,
          model: embedding.model || null,
          purpose,
          inputCount,
          durationMs: Date.now() - startedAt,
          fallback: false,
        });
        recorder?.callFinished?.({
          callId,
          kind: 'embedding',
          purpose,
          status: 'completed',
          response: { vectors },
          durationMs: Date.now() - startedAt,
        });
        return vectors;
      } catch (error) {
        onEvent?.({
          operation: 'embed',
          status: 'degraded',
          provider: embedding.provider || null,
          model: embedding.model || null,
          purpose,
          inputCount,
          durationMs: Date.now() - startedAt,
          fallback: true,
          errorCode: error?.code || error?.name || 'EMBEDDING_ERROR',
        });
        recorder?.callFinished?.({
          callId,
          kind: 'embedding',
          purpose,
          status: isAbortError(error) ? 'cancelled' : 'failed',
          error,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
  if (typeof embedding.embed === 'function') {
    wrapped.embed = (text, options) => embedding.embed(text, options);
  }
  if (typeof embedding.similarity === 'function') {
    wrapped.similarity = (left, right, options) => embedding.similarity(left, right, options);
  }
  return wrapped;
}

function wrapRerank(primary, fallback, {
  budget,
  onEvent,
  recorder,
  nextCallId,
} = {}) {
  return {
    provider: primary.provider,
    model: primary.model,
    async rerank(args) {
      const startedAt = Date.now();
      const callId = nextCallId?.('rerank') || `rerank-${Date.now()}`;
      recorder?.callStarted?.({
        callId,
        kind: 'rerank',
        request: {
          provider: primary.provider,
          model: primary.model,
          args,
        },
      });
      onEvent?.({ operation: 'rerank', status: 'started', provider: primary.provider, model: primary.model, inputCount: args.documents?.length || 0 });
      try {
        const result = await primary.rerank(args);
        budget?.recordRerankUsage(result.usage);
        onEvent?.({ operation: 'rerank', status: 'completed', provider: result.provider, model: result.model, inputCount: args.documents?.length || 0, durationMs: result.durationMs, usage: result.usage, degraded: false });
        recorder?.callFinished?.({
          callId,
          kind: 'rerank',
          status: 'completed',
          response: result,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        if (isAbortError(error) || error?.name === 'BudgetExceededError') {
          recorder?.callFinished?.({
            callId,
            kind: 'rerank',
            status: isAbortError(error) ? 'cancelled' : 'failed',
            error,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
        const result = await fallback.rerank(args);
        const errorCode = error?.code || 'RERANK_PROVIDER_ERROR';
        onEvent?.({ operation: 'rerank', status: 'degraded', provider: primary.provider, model: primary.model, inputCount: args.documents?.length || 0, durationMs: Date.now() - startedAt, errorCode });
        recorder?.callFinished?.({
          callId,
          kind: 'rerank',
          status: 'degraded',
          response: result,
          error,
          durationMs: Date.now() - startedAt,
        });
        return { ...result, degraded: true, degradedFrom: primary.provider, errorCode };
      }
    },
  };
}

function resolveJudge(config, { fetch } = {}) {
  const injected = typeof config?.judge === 'function';
  const settings = resolveJudgeSettings(injected ? { ...config, provider: 'jev' } : config);
  if (!judgeActive(settings)) return null;
  return { primary: injected ? config : new JevJudgeProvider(withFetch(settings, fetch)), settings };
}

function recordedJudgeRequest(primary, { purpose, prepared, questions }) {
  return {
    provider: primary.provider,
    dialect: primary.dialect || null,
    model: primary.model,
    purpose,
    state: { sha256: prepared.sha256, truncated: prepared.truncated, originalChars: prepared.originalChars, sentChars: prepared.sentChars },
    questions: Object.entries(questions).map(([id, question]) => ({ id, type: question.type, sha256: sha256(question) })),
  };
}

const JUDGE_SUSPEND_AFTER_UNAVAILABLE = 3;

function wrapJudge(resolved, { budget, onEvent, recorder, nextCallId } = {}) {
  if (!resolved) return null;
  const { primary, settings } = resolved;
  const memo = new Map();
  let unavailableStreak = 0;
  const identity = { provider: primary.provider, dialect: primary.dialect || null, model: primary.model };
  const degraded = (purpose, errorCode, extra = {}) => {
    onEvent?.({ operation: 'judge', status: 'degraded', ...identity, purpose, errorCode, fallback: true, ...extra });
    return { status: 'degraded', errorCode, ...identity };
  };
  return {
    ...identity,
    identityKey: `${identity.provider}:${identity.dialect || ''}:${identity.model}`,
    batchSize: Math.max(1, Math.floor(Number(settings.batchSize) || 40)),
    thresholds: settings.thresholds,
    features: settings.features,
    allowLocalCorpus: settings.allowLocalCorpus,
    enabled(feature) { return settings.features[feature] === true; },
    async judge({ purpose = 'judge', state, questions, signal } = {}) {
      signal?.throwIfAborted?.();
      const prepared = (primary.prepareState || ((value) => prepareJudgeState(value, settings.maxStateChars))).call(primary, state);
      const request = recordedJudgeRequest(primary, { purpose, prepared, questions });
      const key = JSON.stringify(request);
      if (memo.has(key)) return { ...memo.get(key), cached: true };
      const recovered = budget?.executionVersion === 2 ? recorder?.recoverCall?.('judge', request) : null;
      if (recovered && validateJudgeAnswers(questions, recovered.response?.answers)) {
        budget?.recordJudgeUsage?.(recovered.response.usage, { callId: recovered.callId });
        const result = { status: 'completed', ...identity, answers: recovered.response.answers, truncated: prepared.truncated, recovered: true };
        memo.set(key, result);
        return result;
      }
      if (unavailableStreak >= JUDGE_SUSPEND_AFTER_UNAVAILABLE) return degraded(purpose, 'JUDGE_SUSPENDED');
      if (budget?.canUseJudge && !budget.canUseJudge()) return degraded(purpose, 'JUDGE_BUDGET_EXHAUSTED');
      budget?.claim?.('judgeRequests');
      const startedAt = Date.now();
      const callId = nextCallId?.('judge') || `judge-${Date.now()}`;
      const questionCount = Object.keys(questions || {}).length;
      recorder?.callStarted?.({ callId, kind: 'judge', purpose, request });
      onEvent?.({ operation: 'judge', status: 'started', ...identity, purpose, questionCount, stateTruncated: prepared.truncated });
      try {
        const result = await primary.judge({ state, questions, signal, prepared });
        if (!validateJudgeAnswers(questions, result?.answers)) throw new JudgeProviderError('structure', 'JUDGE_ANSWERS_INVALID', { provider: identity.provider });
        unavailableStreak = 0;
        budget?.recordJudgeUsage?.(result.usage, { callId });
        recorder?.callFinished?.({ callId, kind: 'judge', purpose, status: 'completed',
          response: { model: result.model, answers: result.answers, usage: result.usage }, durationMs: Date.now() - startedAt });
        onEvent?.({ operation: 'judge', status: 'completed', ...identity, purpose, questionCount, durationMs: Date.now() - startedAt,
          usageKnown: result.usage?.known === true, stateTruncated: prepared.truncated });
        const completed = { status: 'completed', ...identity, answers: result.answers, truncated: prepared.truncated };
        memo.set(key, completed);
        return completed;
      } catch (error) {
        const cancelled = isAbortError(error);
        if (cancelled || !isJudgeUnavailable(error)) {
          recorder?.callFinished?.({ callId, kind: 'judge', purpose, status: cancelled ? 'cancelled' : 'failed', error, durationMs: Date.now() - startedAt });
          if (cancelled) budget?.markJudgeUsageUnknown?.();
          throw error;
        }
        if (['JUDGE_TIMEOUT', 'JUDGE_NETWORK_ERROR'].includes(error.code)) budget?.markJudgeUsageUnknown?.();
        else if (error.usage) budget?.recordJudgeUsage?.(error.usage, { callId });
        if (error.category === 'unavailable') unavailableStreak += 1;
        recorder?.callFinished?.({ callId, kind: 'judge', purpose, status: 'degraded', error, durationMs: Date.now() - startedAt });
        return degraded(purpose, error.code, { durationMs: Date.now() - startedAt, errorCategory: error.category });
      }
    },
  };
}

export function createResearchProviders(config = {}, runtime = {}) {
  const sessionDir = runtime.recorder?.sessionDir;
  let callSequence = sessionDir ? Math.max(maxRecordedCallSequence(sessionDir, 'embedding'), maxRecordedCallSequence(sessionDir, 'embed'), maxRecordedCallSequence(sessionDir, 'rerank')) : 0;
  let judgeSequence = sessionDir ? maxRecordedCallSequence(sessionDir, 'judge') : 0;
  const wrappedRuntime = {
    ...runtime,
    nextCallId: (kind) => (kind === 'judge' ? `judge-${++judgeSequence}` : `${kind}-${++callSequence}`),
  };
  const fetch = runtime.fetch;
  const fallback = new RulesRerankProvider(config.rerank || {});
  const rerank = resolveRerank(config.rerank, { budget: runtime.budget, fetch });
  const embedding = cacheEmbedding(wrapEmbedding(resolveEmbedding(config.embedding, { fetch }), wrappedRuntime), { sessionDir: runtime.recorder?.sessionDir });
  return {
    ...deterministicResearchProviders,
    ...config,
    embedding,
    rerank: wrapRerank(rerank, fallback, wrappedRuntime),
    judge: wrapJudge(resolveJudge(config.judge, { fetch }), wrappedRuntime),
  };
}
