import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BudgetExceededError,
  BudgetManager,
  JinaRerankProvider,
  RulesRerankProvider,
  SemanticProviderError,
  createResearchProviders,
} from '../src/index.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('optional rerank providers', () => {
  it('uses deterministic stable ordering without an external provider', async () => {
    const provider = new RulesRerankProvider();
    const result = await provider.rerank({
      query: 'agent research',
      documents: [
        { id: 'weak', text: 'unrelated material' },
        { id: 'first-tie', text: 'agent notes' },
        { id: 'second-tie', text: 'research notes' },
      ],
    });

    assert.deepEqual(result.items.map((item) => item.id), ['first-tie', 'second-tie', 'weak']);
    assert.deepEqual(result.usage, { requests: 0, tokens: 0 });
  });

  it('can disable reranking while preserving candidate order', async () => {
    const providers = createResearchProviders({ rerank: { provider: 'disabled' } });
    const result = await providers.rerank.rerank({
      query: 'agent',
      documents: [{ id: 'first', text: 'unrelated' }, { id: 'second', text: 'agent' }],
    });
    assert.equal(result.provider, 'disabled');
    assert.deepEqual(result.items.map((item) => item.id), ['first', 'second']);
  });

  it('batches Jina requests and restores global document indices', async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return new globalThis.Response(JSON.stringify({
        results: body.documents.map((_document, index) => ({ index, relevance_score: 1 - index * 0.1 })),
        usage: { total_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = new JinaRerankProvider({ apiKey: 'test-key', batchSize: 2 });
    const result = await provider.rerank({
      query: 'q',
      documents: ['a', 'b', 'c'].map((text, index) => ({ id: `d${index}`, text })),
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(result.items.map((item) => item.originalIndex).sort((a, b) => a - b), [0, 1, 2]);
    assert.deepEqual(result.usage, { requests: 2, tokens: 14 });
  });

  it('rejects incomplete provider results instead of silently dropping documents', async () => {
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = new JinaRerankProvider({ apiKey: 'test-key' });
    await assert.rejects(
      provider.rerank({ query: 'q', documents: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] }),
      (error) => error instanceof SemanticProviderError && error.code === 'SEMANTIC_RESULT_INVALID',
    );
  });

  it('degrades provider failures to rules and emits metadata without query or document text', async () => {
    const events = [];
    const providers = createResearchProviders({
      rerank: { provider: 'jina', apiKey: '' },
    }, { onEvent: (event) => events.push(event) });
    const result = await providers.rerank.rerank({ query: 'private query', documents: [{ id: 'a', text: 'secret passage' }] });

    assert.equal(result.provider, 'rules');
    assert.equal(result.degraded, true);
    assert.equal(events.at(-1).status, 'degraded');
    assert.doesNotMatch(JSON.stringify(events), /private query|secret passage/);
  });

  it('propagates cancellation without using the fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    const providers = createResearchProviders({ rerank: { provider: 'jina', apiKey: 'test-key' } });
    await assert.rejects(
      providers.rerank.rerank({ query: 'q', documents: [{ id: 'a', text: 'a' }], signal: controller.signal }),
      (error) => error.name === 'AbortError',
    );
  });

  it('enforces the external rerank request budget before each batch', async () => {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      return new globalThis.Response(JSON.stringify({
        results: body.documents.map((_document, index) => ({ index, relevance_score: 1 })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const budget = new BudgetManager({ research: { budget: { maxRerankRequests: 1 } } });
    const providers = createResearchProviders({ rerank: { provider: 'jina', apiKey: 'test-key', batchSize: 1 } }, { budget });
    await assert.rejects(
      providers.rerank.rerank({ query: 'q', documents: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] }),
      BudgetExceededError,
    );
    assert.equal(budget.snapshot().usage.rerankRequests, 1);
  });
});
