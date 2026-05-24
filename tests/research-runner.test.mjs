import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/research/research-runner.mjs';
import { runStrategy, strategyMetadata } from '../src/research/strategies.mjs';

describe('ResearchRunner', () => {
  it('runs quick research with injected LLM and search adapters', async () => {
    const runner = new ResearchRunner();
    const events = [];
    const result = await runner.run({
      query: 'test topic',
      settings: {
        llm: {
          provider: 'openai-compatible',
          model: 'mock',
          apiKey: 'test',
          baseUrl: 'mock://llm',
          temperature: 0,
          maxTokens: 100,
        },
        search: {
          engine: 'searxng',
          baseUrl: 'mock://search',
          maxResults: 2,
        },
        research: {
          strategy: 'quick',
          questionsPerIteration: 1,
        },
      },
      onProgress: (event) => events.push(event),
      search: {
        async search() {
          return [{ title: 'Source', url: 'https://example.com', snippet: 'Evidence' }];
        },
      },
      llm: {
        async complete() {
          return '# Report\n\nA test report [1.1].';
        },
      },
    });

    assert.match(result.report, /test report/);
    assert.equal(result.sources.length, 1);
    assert.equal(events[0].message, 'Research started');
  });

  it('exposes available research strategies as metadata', () => {
    assert.deepEqual(strategyMetadata.map((strategy) => strategy.id), [
      'quick',
      'source-based',
      'parallel',
    ]);
  });

  it('rejects unsupported research strategies', async () => {
    await assert.rejects(
      runStrategy({ strategy: 'unknown' }),
      /Unsupported research strategy: unknown/,
    );
  });
});
