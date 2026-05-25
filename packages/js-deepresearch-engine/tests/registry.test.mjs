import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLlmProvider,
  createSearchEngine,
  providerMetadata,
  registerLlmProvider,
  registerSearchEngine,
  registerStrategy,
  runStrategy,
  searchEngineMetadata,
  strategyMetadata,
} from '../src/index.mjs';

describe('registry APIs', () => {
  it('registers a custom LLM provider and exposes it in metadata', () => {
    registerLlmProvider('mock-llm', {
      metadata: {
        label: 'Mock LLM',
        requiresApiKey: false,
        supportsBaseUrl: false,
      },
      create: () => ({
        async complete() {
          return 'mock response';
        },
      }),
    });

    assert.ok(providerMetadata.some((entry) => entry.id === 'mock-llm'));

    const provider = createLlmProvider({
      llm: { provider: 'mock-llm' },
    });
    assert.equal(typeof provider.complete, 'function');
  });

  it('registers a custom search engine and exposes it in metadata', async () => {
    registerSearchEngine('mock-search', {
      metadata: {
        label: 'Mock Search',
      },
      create: () => ({
        async search(question) {
          return [{ title: question, url: 'https://example.com', snippet: question }];
        },
      }),
    });

    assert.ok(searchEngineMetadata.some((entry) => entry.id === 'mock-search'));

    const engine = createSearchEngine({
      search: { engine: 'mock-search' },
    });
    const results = await engine.search('hello');
    assert.equal(results[0].title, 'hello');
  });

  it('registers a custom strategy and runs it through runStrategy', async () => {
    registerStrategy('echo', {
      label: 'Echo',
      description: 'Returns a single finding with the query text.',
      requiresLlm: false,
      supportsIterations: false,
      supportsConcurrency: false,
      speed: 'fast',
      depth: 'light',
      run: async ({ query, emit }) => {
        emit('Echo strategy running', 50);
        return [{ question: query, sources: [] }];
      },
    });

    assert.ok(strategyMetadata.some((entry) => entry.id === 'echo'));

    const events = [];
    const findings = await runStrategy({
      strategy: 'echo',
      query: 'custom strategy query',
      emit: (message, progress) => events.push({ message, progress }),
    });

    assert.deepEqual(findings, [{ question: 'custom strategy query', sources: [] }]);
    assert.deepEqual(events, [{ message: 'Echo strategy running', progress: 50 }]);
  });
});
