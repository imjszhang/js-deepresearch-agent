import { SemanticProviderError, createTimeoutSignal, isAbortError } from './semantic-provider-errors.mjs';

export class HttpRerankProvider {
  constructor(config = {}, { onRequest } = {}) {
    this.provider = config.providerName || 'http';
    this.model = config.model || 'mixedbread-ai/mxbai-rerank-xsmall-v1';
    this.baseUrl = String(config.baseUrl || 'http://127.0.0.1:8000').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.batchSize = Math.max(1, Number(config.batchSize) || 100);
    this.timeoutMs = Math.max(1, Number(config.timeoutMs) || 30000);
    this.onRequest = onRequest;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
  }

  async rerank({ query, documents = [], topK, signal }) {
    signal?.throwIfAborted?.();
    const startedAt = Date.now();
    const items = [];
    let tokens = 0;
    let requests = 0;

    for (let offset = 0; offset < documents.length; offset += this.batchSize) {
      const batch = documents.slice(offset, offset + this.batchSize);
      const timed = createTimeoutSignal(signal, this.timeoutMs);
      try {
        this.onRequest?.({ operation: 'rerank', inputCount: batch.length });
        requests += 1;
        const headers = { 'content-type': 'application/json' };
        if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
        const response = await this.fetch(`${this.baseUrl}/rerank`, {
          method: 'POST',
          signal: timed.signal,
          headers,
          body: JSON.stringify({
            model: this.model,
            query,
            top_n: batch.length,
            documents: batch.map((item) => item.text),
          }),
        });
        if (!response.ok) {
          throw new SemanticProviderError(`HTTP rerank failed (${response.status}).`, {
            provider: this.provider,
            operation: 'rerank',
            code: `HTTP_${response.status}`,
          });
        }
        const data = await response.json();
        const seen = new Set();
        for (const result of data.results || []) {
          const index = Number(result.index);
          if (!Number.isInteger(index) || index < 0 || index >= batch.length || seen.has(index) || !Number.isFinite(Number(result.relevance_score))) continue;
          seen.add(index);
          items.push({ id: batch[index].id, originalIndex: offset + index, score: Number(result.relevance_score) });
        }
        if (seen.size !== batch.length) {
          throw new SemanticProviderError('HTTP rerank returned incomplete or invalid indices.', {
            provider: this.provider,
            operation: 'rerank',
            code: 'SEMANTIC_RESULT_INVALID',
          });
        }
        const usageTokens = Number(data.usage?.total_tokens);
        if (Number.isFinite(usageTokens)) tokens += usageTokens;
      } catch (error) {
        if (error?.name === 'BudgetExceededError') throw error;
        if (isAbortError(error) && signal?.aborted) throw error;
        if (timed.timedOut()) {
          throw new SemanticProviderError(`HTTP rerank timed out after ${this.timeoutMs}ms.`, {
            provider: this.provider,
            operation: 'rerank',
            code: 'SEMANTIC_TIMEOUT',
            cause: error,
          });
        }
        if (error instanceof SemanticProviderError) throw error;
        throw new SemanticProviderError(error.message || 'HTTP rerank failed.', {
          provider: this.provider,
          operation: 'rerank',
          cause: error,
        });
      } finally {
        timed.cleanup();
      }
    }

    items.sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);
    return {
      items: Number(topK) > 0 ? items.slice(0, topK) : items,
      provider: this.provider,
      model: this.model,
      usage: { requests, tokens },
      durationMs: Date.now() - startedAt,
      degraded: false,
    };
  }
}
