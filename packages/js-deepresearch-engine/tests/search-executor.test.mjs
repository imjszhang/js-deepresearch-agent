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

    assert.equal(results[0].sources.length, 1);
    assert.equal(results[1].question, 'fail');
    assert.deepEqual(results[1].sources, []);
    assert.match(results[1].error.message, /boom/);
  });
});
