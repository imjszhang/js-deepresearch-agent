import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runStrategy } from '../src/research/strategies.mjs';

describe('iterative strategy pipeline', () => {
  it('uses focused discovery, repair, and bounded challenge waves', async () => {
    const searchedQuestions = [];
    let questionGenerationCalls = 0;

    const findings = await runStrategy({
      strategy: 'focused',
      query: 'deep topic',
      settings: {
        research: {
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
          focused: {
            fetchMode: 'disabled',
            iterationControl: { enabled: false },
          },
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
        async complete({ purpose, messages }) {
          questionGenerationCalls += 1;
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [
                { answerSlot: 'deep topic', question: 'deep topic', priority: 'critical' },
                { answerSlot: 'first iteration question', question: 'first iteration question' },
              ],
            });
          }
          if (messages[1]?.content.includes('Context:')) {
            return JSON.stringify(['second iteration question']);
          }
          return JSON.stringify(['first iteration question']);
        },
      },
      emit: () => {},
    });

    assert.ok(searchedQuestions.includes('deep topic'));
    assert.ok(searchedQuestions.includes('first iteration question'));
    assert.ok(searchedQuestions.some((question) => question.includes('primary source evidence')));
    assert.ok(questionGenerationCalls >= 1);
    assert.ok(findings.some((finding) => finding.wave === 'discovery'));
    assert.ok(findings.some((finding) => finding.wave === 'repair'));
  });

  it('uses the shared iterative pipeline for multi-round quick research', async () => {
    const searchedQuestions = [];

    const findings = await runStrategy({
      strategy: 'quick',
      query: 'quick topic',
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
            ? JSON.stringify(['quick follow-up'])
            : JSON.stringify(['quick initial']);
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, [
      'quick topic',
      'quick initial',
      'quick follow-up',
    ]);
    assert.deepEqual(findings.map((finding) => finding.iteration), [1, 1, 2]);
  });

  it('keeps single-iteration quick research on the original query plus limited follow-ups', async () => {
    const searchedQuestions = [];
    const findings = await runStrategy({
      strategy: 'quick',
      query: 'single round',
      settings: {
        research: {
          iterations: 1,
          questionsPerIteration: 2,
          concurrency: 1,
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{ title: question, url: `https://example.com/${searchedQuestions.length}`, snippet: question }];
        },
      },
      llm: {
        async complete() {
          return JSON.stringify(['follow one', 'follow two']);
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, ['single round', 'follow one', 'follow two']);
    assert.equal(findings.every((finding) => finding.iteration == null), true);
  });
});
