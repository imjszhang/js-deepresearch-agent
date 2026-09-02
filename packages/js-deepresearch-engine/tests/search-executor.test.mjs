import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchQuestions } from '../src/research/search-executor.mjs';

describe('searchQuestions', () => {
  it('limits concurrent searches and preserves result order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await searchQuestions({
      questions: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      search: {
        async search(question) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return [{ title: question, url: `https://example.com/${question}`, snippet: question }];
        },
      },
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(results.map((result) => result.question), ['a', 'b', 'c', 'd']);
  });

  it('keeps failed searches scoped to their question', async () => {
    const results = await searchQuestions({
      questions: ['ok', 'fail'],
      concurrency: 2,
      search: {
        async search(question) {
          if (question === 'fail') throw new Error('boom');
          return [{ title: question, url: 'https://example.com', snippet: question }];
        },
      },
    });

    assert.equal(results[1].question, 'fail');
    assert.deepEqual(results[1].sources, []);
    assert.match(results[1].error.message, /boom/);
    assert.equal(results[1].error.name, 'Error');
  });

  it('propagates AbortError instead of swallowing it', async () => {
    const abortError = new Error('Research aborted');
    abortError.name = 'AbortError';

    await assert.rejects(
      () => searchQuestions({
        questions: ['one', 'two'],
        search: {
          async search() {
            throw abortError;
          },
        },
      }),
      { name: 'AbortError' },
    );
  });

  it('stops scheduling new searches after abort', async () => {
    const controller = new AbortController();
    const seen = [];

    const promise = searchQuestions({
      questions: ['a', 'b', 'c'],
      concurrency: 1,
      signal: controller.signal,
      search: {
        async search(question) {
          seen.push(question);
          if (question === 'a') controller.abort();
          return [{ title: question, url: `https://example.com/${question}`, snippet: question }];
        },
      },
    });

    await assert.rejects(promise, { name: 'AbortError' });
    assert.deepEqual(seen, ['a']);
  });

  it('forwards per-query searchOptions and reports searchMeta via onResult', async () => {
    const seen = [];
    const results = await searchQuestions({
      questions: [{ question: '智谱', searchOptions: { engines: 'brave', language: 'zh' } }],
      search: {
        async search(query, options) {
          seen.push({ query, options });
          const sources = [{ title: query, url: 'https://example.com', snippet: query }];
          Object.defineProperty(sources, Symbol.for('jdr.searchMeta'), {
            value: { respondedEngines: ['brave'], requestParams: options.searchOptions },
          });
          return sources;
        },
      },
      onResult(result) {
        seen.push({ meta: result.searchMeta, options: result.searchOptions });
      },
    });
    assert.equal(seen[0].options.searchOptions.engines, 'brave');
    assert.deepEqual(results[0].searchMeta.respondedEngines, ['brave']);
    assert.equal(results[0].searchQuery, '智谱');
  });
});
