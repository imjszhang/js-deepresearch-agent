import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ResearchRunner,
  registerSearchEngine,
  resetEngineRegistries,
} from '../src/index.mjs';

function validReport(marker = 'fanout report') {
  return `# Research Report\n\n## Summary\n\nThis ${marker} summarizes the collected evidence and clearly distinguishes verified observations from unresolved limitations. It provides enough structured prose to validate the report output contract without relying on an empty or placeholder response.\n\n## Caveats\n\nThe test evidence is intentionally limited.`;
}

function registerMockBackends() {
  registerSearchEngine('mock-a', {
    create: (config) => ({
      capabilities: { maxQuestionConcurrency: config.concurrencyLimit ?? null },
      async search(question) {
        return [{
          title: `Web ${question}`,
          url: `https://web.example/${encodeURIComponent(question)}`,
          snippet: `web snippet for ${question}`,
          engine: 'searxng',
          content: `Official documentation about ${question}.`,
          fetchStatus: 'ok',
          contentOrigin: 'fetched',
        }];
      },
    }),
  });
  registerSearchEngine('mock-b', {
    create: () => ({
      capabilities: { maxQuestionConcurrency: 1 },
      async search(question) {
        return [{
          title: `Community ${question}`,
          url: `https://zhihu.example/${encodeURIComponent(question)}`,
          snippet: `community snippet for ${question}`,
          engine: 'js-eyes:zhihu',
        }];
      },
    }),
  });
}

function fanoutSettings(strategy, extra = {}) {
  return {
    llm: {},
    search: {
      mode: 'fanout',
      maxResults: 8,
      backends: [
        { id: 'web', engine: 'mock-a', enabled: true, settings: { maxResults: 4 } },
        { id: 'community', engine: 'mock-b', enabled: true, settings: { maxResults: 4 } },
      ],
      fanout: { failurePolicy: 'partial', merge: 'round-robin', maxParallelBackends: 2 },
    },
    research: {
      strategy,
      iterations: 1,
      questionsPerIteration: 1,
      concurrency: 2,
      budget: { maxSearchRequests: 8, maxSearchBackendRequests: 0, maxSourceReads: 0, maxLlmTokens: 0 },
      focused: { fetchMode: 'disabled', iterationControl: { enabled: false } },
      exploratory: { maxSteps: 4, maxEvaluationRetries: 0, maxQueriesPerStep: 1, autoReadTopK: 0, minLlmTokens: 0, maxLlmTokens: 0 },
      ...extra.research,
    },
  };
}

describe('ResearchRunner fan-out integration', () => {
  afterEach(() => {
    resetEngineRegistries();
  });

  it('runs quick, focused, and exploratory with the same two mock backends', async () => {
    registerMockBackends();
    const runner = new ResearchRunner();

    const quick = await runner.run({
      query: 'fanout topic',
      settings: fanoutSettings('quick'),
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'question_generation' || messages?.[0]?.content?.includes('research planner')) {
            return JSON.stringify(['quick follow-up']);
          }
          return validReport('quick fanout report [1.1]');
        },
      },
    });
    assert.ok(quick.sources.some((source) => source.engine === 'searxng'));
    assert.ok(quick.sources.some((source) => source.engine === 'js-eyes:zhihu'));
    assert.equal(quick.quality.budget.usage.searchRequests >= 1, true);
    assert.equal(quick.quality.budget.usage.searchBackendRequests, quick.quality.budget.usage.searchRequests * 2);
    assert.ok(quick.trace.some((entry) => entry.action === 'search_backend' && entry.backendId === 'web' && entry.status === 'ok'));
    assert.ok(quick.trace.some((entry) => entry.action === 'search_backend' && entry.backendId === 'community'));

    const focused = await runner.run({
      query: 'fanout focused topic',
      settings: fanoutSettings('focused'),
      llm: {
        async complete({ purpose }) {
          if (purpose === 'question_generation') return JSON.stringify(['focused follow-up']);
          return validReport('focused fanout report [1.1]');
        },
      },
    });
    assert.ok(focused.findings.some((finding) => finding.sources.some((source) => source.engine === 'searxng')));
    assert.ok(focused.findings.some((finding) => finding.sources.some((source) => source.engine === 'js-eyes:zhihu')));
    assert.ok(focused.gaps.length >= 1);
    assert.ok(focused.sources.length >= 2);

    const decisions = [
      { action: 'search', query: 'fanout exploratory topic', gapId: 'gap-1', reasonCode: 'find_sources' },
      { action: 'answer', reasonCode: 'evidence_sufficient' },
    ];
    const exploratory = await runner.run({
      query: 'fanout exploratory topic',
      settings: fanoutSettings('exploratory'),
      llm: {
        async complete({ purpose }) {
          if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
          if (purpose === 'gap_decomposition') return '{"subQuestions":[]}';
          return validReport('exploratory fanout report [1.1]');
        },
      },
    });
    assert.ok(exploratory.sources.some((source) => source.engine === 'searxng'));
    assert.ok(exploratory.trace.some((entry) => entry.action === 'search_backend'));
    assert.ok(exploratory.quality.budget.usage.searchBackendRequests >= exploratory.quality.budget.usage.searchRequests);
  });
});
