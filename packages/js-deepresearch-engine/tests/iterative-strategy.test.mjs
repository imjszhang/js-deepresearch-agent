import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runStrategy } from '../src/research/strategies.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

describe('iterative strategy pipeline', () => {
  it('uses focused discovery, repair, and bounded challenge waves', async () => {
    const searchedQuestions = [];
    let questionGenerationCalls = 0;
    const trace = [];

    const findings = await runStrategy({
      strategy: 'focused',
      query: 'deep topic',
      trace,
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
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [
                { answerSlot: 'deep topic', question: 'deep topic', priority: 'critical' },
                { answerSlot: 'first iteration question', question: 'first iteration question' },
              ],
            });
          }
          if (messages[1]?.content.includes('Context:')) {
            return JSON.stringify({ queries: [{ query: 'second iteration question' }] });
          }
          return JSON.stringify({ queries: [{ query: 'first iteration question' }] });
        },
      },
      emit: () => {},
    });

    assert.ok(searchedQuestions.includes('deep topic'));
    assert.ok(searchedQuestions.includes('first iteration question'));
    assert.ok(!searchedQuestions.some((question) => question.includes('primary source evidence')));
    assert.ok(questionGenerationCalls >= 1);
    assert.ok(findings.some((finding) => finding.wave === 'discovery'));
    assert.ok(findings.some((finding) => finding.wave === 'repair'));
    const searchTraces = trace.filter((entry) => entry.action === 'search');
    assert.ok(searchTraces.length >= searchedQuestions.length);
    assert.ok(searchTraces.every((entry) => ['user_query', 'llm_planner'].includes(entry.queryOrigin)));
    assert.ok(searchTraces.every((entry) => entry.outcome));
  });

  it('uses the shared iterative pipeline for multi-round quick research', async () => {
    const searchedQuestions = [];
    const trace = [];

    const findings = await runStrategy({
      strategy: 'quick',
      query: 'quick topic',
      trace,
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
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') {
            const user = JSON.parse(messages.find((item) => item.role === 'user')?.content || '{}');
            return JSON.stringify({
              queries: [{ query: user.context ? 'quick follow-up' : 'quick initial' }],
            });
          }
          return JSON.stringify({ queries: [{ query: 'quick initial' }] });
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
    const searchTraces = trace.filter((entry) => entry.action === 'search');
    assert.equal(searchTraces.length, searchedQuestions.length);
    assert.ok(searchTraces.every((entry) => entry.queryOrigin));
    const followUpPlan = trace.find((entry) => entry.reasonCode === 'search_query_followup');
    assert.ok(followUpPlan);
    assert.ok((followUpPlan.plannedQueries || []).every((item) => item.query !== 'quick topic'));
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
        async complete({ purpose }) {
          if (purpose === 'search_query_planning') {
            return JSON.stringify({
              queries: [{ query: 'follow one' }, { query: 'follow two' }],
            });
          }
          return JSON.stringify({ queries: [] });
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, ['single round', 'follow one', 'follow two']);
    assert.equal(findings.every((finding) => finding.iteration == null), true);
  });
});
