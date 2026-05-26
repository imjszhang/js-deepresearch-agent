import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runStrategy } from '../src/research/strategies.mjs';

describe('iterative strategy pipeline', () => {
  it('includes the original query on the first iteration and uses context afterward', async () => {
    const searchedQuestions = [];
    let questionGenerationCalls = 0;

    const findings = await runStrategy({
      strategy: 'source-based',
      query: 'deep topic',
      settings: {
        research: {
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{
            title: question,
            url: `https://example.com/${searchedQuestions.length}`,
            snippet: `Snippet for ${question}`,
          }];
        },
      },
      llm: {
        async complete({ messages }) {
          questionGenerationCalls += 1;
          if (messages[1].content.includes('Context:')) {
            return JSON.stringify(['second iteration question']);
          }
          return JSON.stringify(['first iteration question']);
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, [
      'deep topic',
      'first iteration question',
      'second iteration question',
    ]);
    assert.equal(questionGenerationCalls, 2);
    assert.deepEqual(findings.map((finding) => finding.iteration), [1, 1, 2]);
  });

  it('preserves parallel strategy search ordering and iteration markers', async () => {
    const searchedQuestions = [];

    const findings = await runStrategy({
      strategy: 'parallel',
      query: 'parallel topic',
      settings: {
        research: {
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{
            title: question,
            url: `https://example.com/${searchedQuestions.length}`,
            snippet: question,
          }];
        },
      },
      llm: {
        async complete({ messages }) {
          return messages[1].content.includes('Context:')
            ? JSON.stringify(['parallel follow-up'])
            : JSON.stringify(['parallel initial']);
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, [
      'parallel topic',
      'parallel initial',
      'parallel follow-up',
    ]);
    assert.deepEqual(findings.map((finding) => finding.iteration), [1, 1, 2]);
  });
});
