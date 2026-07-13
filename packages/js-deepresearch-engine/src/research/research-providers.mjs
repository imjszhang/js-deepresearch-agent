import { querySimilarity } from './query-memory.mjs';
import { JinaRerankProvider } from './providers/jina-rerank-provider.mjs';
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

function resolveRerank(config, { budget } = {}) {
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
  throw new Error(`Unsupported rerank provider: ${config.provider}`);
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
  const fallback = new RulesRerankProvider(config.rerank || {});
  const rerank = resolveRerank(config.rerank, runtime);
  return {
    ...deterministicResearchProviders,
    ...config,
    embedding: (config.embedding?.embed || config.embedding?.embedDocuments) ? config.embedding : null,
    rerank: wrapRerank(rerank, fallback, runtime),
  };
}
