import { querySimilarity } from './query-memory.mjs';
import { HttpRerankProvider } from './providers/http-rerank-provider.mjs';
import { JinaRerankProvider } from './providers/jina-rerank-provider.mjs';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding-provider.mjs';
import { DisabledRerankProvider, RulesRerankProvider } from './providers/rules-rerank-provider.mjs';
import { isAbortError } from './providers/semantic-provider-errors.mjs';

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

function wrapEmbedding(embedding, { onEvent } = {}) {
  if (!embedding) return null;
  const wrapped = {
    ...embedding,
    provider: embedding.provider,
    model: embedding.model,
    async embedDocuments(texts = [], options = {}) {
      const startedAt = Date.now();
      const purpose = options.purpose || 'embed';
      const inputCount = Array.isArray(texts) ? texts.length : 0;
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

function wrapRerank(primary, fallback, { budget, onEvent } = {}) {
  return {
    provider: primary.provider,
    model: primary.model,
    async rerank(args) {
      const startedAt = Date.now();
      onEvent?.({ operation: 'rerank', status: 'started', provider: primary.provider, model: primary.model, inputCount: args.documents?.length || 0 });
      try {
        const result = await primary.rerank(args);
        budget?.recordRerankUsage(result.usage);
        onEvent?.({ operation: 'rerank', status: 'completed', provider: result.provider, model: result.model, inputCount: args.documents?.length || 0, durationMs: result.durationMs, usage: result.usage, degraded: false });
        return result;
      } catch (error) {
        if (isAbortError(error) || error?.name === 'BudgetExceededError') throw error;
        const result = await fallback.rerank(args);
        const errorCode = error?.code || 'RERANK_PROVIDER_ERROR';
        onEvent?.({ operation: 'rerank', status: 'degraded', provider: primary.provider, model: primary.model, inputCount: args.documents?.length || 0, durationMs: Date.now() - startedAt, errorCode });
        return { ...result, degraded: true, degradedFrom: primary.provider, errorCode };
      }
    },
  };
}

export function createResearchProviders(config = {}, runtime = {}) {
  const fetch = runtime.fetch;
  const fallback = new RulesRerankProvider(config.rerank || {});
  const rerank = resolveRerank(config.rerank, { budget: runtime.budget, fetch });
  const embedding = wrapEmbedding(resolveEmbedding(config.embedding, { fetch }), runtime);
  return {
    ...deterministicResearchProviders,
    ...config,
    embedding,
    rerank: wrapRerank(rerank, fallback, runtime),
  };
}
