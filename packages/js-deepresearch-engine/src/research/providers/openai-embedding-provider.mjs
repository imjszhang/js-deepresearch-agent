import { SemanticProviderError, createTimeoutSignal, isAbortError } from './semantic-provider-errors.mjs';

export function cosineSimilarity(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (!normLeft || !normRight) return 0;
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

export class OpenAiEmbeddingProvider {
  constructor(config = {}, { onRequest } = {}) {
    this.provider = config.providerName || config.provider || 'openai-compatible';
    this.model = config.model || 'openclaw/default';
    this.baseUrl = String(config.baseUrl || 'http://127.0.0.1:18789').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.batchSize = Math.min(128, Math.max(1, Number(config.batchSize) || 64));
    this.timeoutMs = Math.max(1, Number(config.timeoutMs) || 60000);
    this.onRequest = onRequest;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
  }

  async embedDocuments(texts = [], { signal } = {}) {
    const inputs = texts.map((text) => String(text || '').trim()).filter(Boolean);
    if (!inputs.length) return [];
    const vectors = [];
    for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
      const batch = inputs.slice(offset, offset + this.batchSize);
      const batchVectors = await this.#requestEmbeddings(batch, { signal });
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  async embed(text, options = {}) {
    const [vector] = await this.embedDocuments([text], options);
    if (!vector) {
      throw new SemanticProviderError('Embedding provider returned an empty vector.', {
        provider: this.provider,
        operation: 'embed',
        code: 'SEMANTIC_RESULT_INVALID',
      });
    }
    return vector;
  }

  async similarity(left, right, options = {}) {
    const [leftVector, rightVector] = await this.embedDocuments([left, right], options);
    return cosineSimilarity(leftVector, rightVector);
  }

  async #requestEmbeddings(inputs, { signal }) {
    signal?.throwIfAborted?.();
    const timed = createTimeoutSignal(signal, this.timeoutMs);
    try {
      this.onRequest?.({ operation: 'embed', inputCount: inputs.length });
      const headers = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        signal: timed.signal,
        headers,
        body: JSON.stringify({ model: this.model, input: inputs.length === 1 ? inputs[0] : inputs }),
      });
      if (!response.ok) {
        throw new SemanticProviderError(`HTTP embedding failed (${response.status}).`, {
          provider: this.provider,
          operation: 'embed',
          code: `HTTP_${response.status}`,
        });
      }
      const data = await response.json();
      const rows = Array.isArray(data.data) ? [...data.data] : [];
      rows.sort((left, right) => Number(left.index) - Number(right.index));
      const vectors = rows.map((row) => row.embedding).filter((vector) => Array.isArray(vector) && vector.length > 0);
      if (vectors.length !== inputs.length) {
        throw new SemanticProviderError('HTTP embedding returned incomplete vectors.', {
          provider: this.provider,
          operation: 'embed',
          code: 'SEMANTIC_RESULT_INVALID',
        });
      }
      return vectors;
    } catch (error) {
      if (error?.name === 'BudgetExceededError') throw error;
      if (isAbortError(error) && signal?.aborted) throw error;
      if (timed.timedOut()) {
        throw new SemanticProviderError(`HTTP embedding timed out after ${this.timeoutMs}ms.`, {
          provider: this.provider,
          operation: 'embed',
          code: 'SEMANTIC_TIMEOUT',
          cause: error,
        });
      }
      if (error instanceof SemanticProviderError) throw error;
      throw new SemanticProviderError(error.message || 'HTTP embedding failed.', {
        provider: this.provider,
        operation: 'embed',
        cause: error,
      });
    } finally {
      timed.cleanup();
    }
  }
}
