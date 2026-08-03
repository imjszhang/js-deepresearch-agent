import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  OpenAiEmbeddingProvider,
  SemanticProviderError,
  cosineSimilarity,
  createResearchProviders,
} from '../src/index.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenAI-compatible embedding provider', () => {
  it('computes cosine similarity for normalized vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it('embeds a single text via /v1/embeddings', async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:18789/v1/embeddings');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'openclaw/default');
      assert.equal(body.input, 'hello');
      return new globalThis.Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'token' });
    const vector = await provider.embed('hello');
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  });

  it('batches document embeddings and preserves order', async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      calls.push(inputs);
      return new globalThis.Response(JSON.stringify({
        data: inputs.map((text, index) => ({ index, embedding: [index, index + 1] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = new OpenAiEmbeddingProvider({ batchSize: 2 });
    const vectors = await provider.embedDocuments(['a', 'b', 'c']);
    assert.equal(calls.length, 2);
    assert.deepEqual(vectors, [[0, 1], [1, 2], [0, 1]]);
  });

  it('rejects incomplete embedding responses', async () => {
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = new OpenAiEmbeddingProvider();
    await assert.rejects(
      provider.embedDocuments(['a', 'b']),
      (error) => error instanceof SemanticProviderError && error.code === 'SEMANTIC_RESULT_INVALID',
    );
  });

  it('registers through createResearchProviders when enabled', () => {
    const providers = createResearchProviders({
      embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:18789' },
    });
    assert.ok(providers.embedding);
    assert.equal(typeof providers.embedding.embedDocuments, 'function');
  });

  it('keeps embedding disabled by default', () => {
    const providers = createResearchProviders({});
    assert.equal(providers.embedding, null);
  });

  it('uses injected fetch instead of global fetch', async () => {
    let injectedCalled = false;
    const injectedFetch = async () => {
      injectedCalled = true;
      return new globalThis.Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.5] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    globalThis.fetch = async () => {
      throw new Error('global fetch should not be used');
    };

    const provider = new OpenAiEmbeddingProvider({ fetch: injectedFetch });
    const vector = await provider.embed('hello');
    assert.equal(injectedCalled, true);
    assert.deepEqual(vector, [0.5]);
  });

  it('passes runtime fetch into createResearchProviders embedding config', async () => {
    let injectedCalled = false;
    const injectedFetch = async () => {
      injectedCalled = true;
      return new globalThis.Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.7] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    globalThis.fetch = async () => {
      throw new Error('global fetch should not be used');
    };

    const providers = createResearchProviders({
      embedding: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:18789' },
    }, { fetch: injectedFetch });
    const vector = await providers.embedding.embed('hello');
    assert.equal(injectedCalled, true);
    assert.deepEqual(vector, [0.7]);
  });
});
