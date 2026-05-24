import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/research/research-runner.mjs';
import { runStrategy, strategyMetadata } from '../src/research/strategies.mjs';

describe('ResearchRunner', () => {
  it('runs rapid research with injected LLM and search adapters', async () => {
    const runner = new ResearchRunner();
    const events = [];
    const searchedQuestions = [];
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
          strategy: 'rapid',
          questionsPerIteration: 2,
          concurrency: 2,
        },
      },
      onProgress: (event) => events.push(event),
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{ title: `Source for ${question}`, url: `https://example.com/${searchedQuestions.length}`, snippet: 'Evidence' }];
        },
      },
      llm: {
        async complete({ messages }) {
          if (messages[0].content.includes('research planner')) {
            return JSON.stringify(['follow up one', 'follow up two']);
          }
          return '# Report\n\nA test report [1.1].';
        },
      },
    });

    assert.match(result.report, /test report/);
    assert.deepEqual(searchedQuestions, ['test topic', 'follow up one', 'follow up two']);
    assert.equal(result.sources.length, 3);
    assert.equal(events[0].message, 'Research started');
  });

  it('exposes available research strategies as metadata', () => {
    assert.deepEqual(strategyMetadata.map((strategy) => strategy.id), [
      'rapid',
      'source-based',
      'parallel',
    ]);
    assert.equal(strategyMetadata[0].supportsConcurrency, true);
  });

  it('runs source-based research across configured iterations', async () => {
    const searchedQuestions = [];
    const runner = new ResearchRunner();

    const result = await runner.run({
      query: 'deep topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'source-based',
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{ title: question, url: `https://example.com/${searchedQuestions.length}`, snippet: `Snippet for ${question}` }];
        },
      },
      llm: {
        async complete({ messages }) {
          if (messages[0].content.includes('research planner')) {
            return messages[1].content.includes('Context:')
              ? JSON.stringify(['second iteration question'])
              : JSON.stringify(['first iteration question']);
          }
          return '# Report\n\nA source-based report.';
        },
      },
    });

    assert.deepEqual(searchedQuestions, [
      'deep topic',
      'first iteration question',
      'second iteration question',
    ]);
    assert.deepEqual(result.findings.map((finding) => finding.iteration), [1, 1, 2]);
  });

  it('rejects unsupported research strategies', async () => {
    await assert.rejects(
      runStrategy({ strategy: 'unknown' }),
      /Unsupported research strategy: unknown/,
    );
  });
});
