import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyResearchFlags,
  formatHistory,
  getDeepValue,
  parseArgs,
  setDeepValue,
} from '../src/cli-utils.mjs';

describe('CLI utilities', () => {
  it('parses positional args and flags', () => {
    const parsed = parseArgs(['hello', 'world', '--strategy', 'rapid', '--json']);
    assert.deepEqual(parsed.args, ['hello', 'world']);
    assert.equal(parsed.flags.strategy, 'rapid');
    assert.equal(parsed.flags.json, true);
  });

  it('sets and gets nested values', () => {
    const target = { llm: { provider: 'openai-compatible' } };
    setDeepValue(target, 'llm.provider', 'ollama');
    setDeepValue(target, 'research.questionsPerIteration', '4');

    assert.equal(getDeepValue(target, 'llm.provider'), 'ollama');
    assert.equal(getDeepValue(target, 'research.questionsPerIteration'), 4);
  });

  it('formats empty history', () => {
    assert.equal(formatHistory([]), 'No research history.');
  });

  it('maps js-eyes skill flags into search provider settings', () => {
    const settings = applyResearchFlags({
      search: {
        engine: 'js-eyes',
        jsEyesSkill: 'js-zhihu-ops-skill',
        options: {
          jsEyesSkill: 'js-x-ops-skill',
          jsEyesSkills: ['js-x-ops-skill'],
        },
      },
    }, {
      'js-eyes-skill': 'js-x-ops-skill,js-zhihu-ops-skill',
    });

    assert.equal(settings.search.jsEyesSkill, 'js-x-ops-skill');
    assert.deepEqual(settings.search.jsEyesSkills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
    assert.deepEqual(settings.search.provider.skills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
  });

  it('maps search-skills alias into provider settings', () => {
    const settings = applyResearchFlags({ search: {} }, {
      'search-skills': 'js-reddit-ops-skill',
      'search-server-url': 'ws://127.0.0.1:18080',
    });

    assert.deepEqual(settings.search.provider.skills, ['js-reddit-ops-skill']);
    assert.equal(settings.search.provider.serverUrl, 'ws://127.0.0.1:18080');
  });

  it('normalizes js-eyes-skills alias and deduplicates entries', () => {
    const settings = applyResearchFlags({ search: {} }, {
      'js-eyes-skills': ' a ; a b ',
    });

    assert.equal(settings.search.jsEyesSkill, 'a');
    assert.deepEqual(settings.search.provider.skills, ['a', 'b']);
  });

  it('maps source-based enrichment flags into research settings', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'source-fetch-mode': 'summary',
      'source-max-urls': '12',
      'source-enable-filter': 'true',
      'source-max-sources': '20',
    });

    assert.equal(settings.research.sourceBased.fetchMode, 'summary');
    assert.equal(settings.research.sourceBased.maxUrlsTotal, 12);
    assert.equal(settings.research.sourceBased.enableRelevanceFilter, true);
    assert.equal(settings.research.sourceBased.maxSourcesForReport, 20);
  });

  it('maps source fetch backend flag into research settings', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'source-fetch-backend': 'js-eyes',
    });

    assert.equal(settings.research.sourceBased.fetchBackend, 'js-eyes');
  });

  it('maps other search runtime flags for one-off research runs', () => {
    const settings = applyResearchFlags({ search: {} }, {
      search: 'js-eyes',
      'search-cli': 'custom-js-eyes',
      'search-server-url': 'ws://127.0.0.1:18080',
      'search-max-pages': '2',
      'search-timeout-ms': '45000',
    });

    assert.equal(settings.search.engine, 'js-eyes');
    assert.equal(settings.search.provider.cli, 'custom-js-eyes');
    assert.equal(settings.search.provider.serverUrl, 'ws://127.0.0.1:18080');
    assert.equal(settings.search.provider.maxPages, 2);
    assert.equal(settings.search.provider.timeoutMs, 45000);
  });

  it('maps budget and Schema v3 feature flags with explicit booleans', () => {
    const settings = applyResearchFlags({ search: {}, research: {} }, {
      strategy: 'adaptive',
      'max-search-requests': '12',
      'max-source-reads': '5',
      'source-adaptive-control': 'true',
      'source-query-memory': 'false',
      'source-cluster-results': 'true',
      'source-evidence-passages': 'true',
      'source-claim-alignment': 'true',
      'source-pre-report-gate': 'true',
    });
    assert.equal(settings.research.strategy, 'adaptive');
    assert.equal(settings.research.budget.maxSearchRequests, 12);
    assert.equal(settings.research.budget.maxSourceReads, 5);
    assert.equal(settings.research.sourceBased.adaptiveControl.enabled, true);
    assert.equal(settings.research.sourceBased.queryMemory.enabled, false);
    assert.equal(settings.research.sourceBased.sourceSelection.enabled, true);
    assert.equal(settings.research.sourceBased.evidencePassages.claimAlignment, true);
    assert.equal(settings.research.sourceBased.preReportGate.enabled, true);
  });

  it('maps optional rerank flags without persisting them', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'max-rerank-requests': '3',
      'max-rerank-tokens': '900',
      'rerank-provider': 'jina',
      'rerank-model': 'custom-reranker',
      'rerank-base-url': 'https://rerank.example/v1',
      'rerank-api-key': 'one-run-key',
      'rerank-timeout-ms': '1234',
      'adaptive-loop-version': 'v2',
    });
    assert.equal(settings.research.budget.maxRerankRequests, 3);
    assert.equal(settings.research.budget.maxRerankTokens, 900);
    assert.deepEqual(settings.research.providers.rerank, {
      provider: 'jina',
      model: 'custom-reranker',
      baseUrl: 'https://rerank.example/v1',
      apiKey: 'one-run-key',
      timeoutMs: 1234,
    });
    assert.equal(settings.research.adaptive.loopVersion, 'v2');
  });

  it('maps embedding and extract fetch mode flags', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'embedding-provider': 'openai-compatible',
      'embedding-base-url': 'http://127.0.0.1:18789',
      'embedding-model': 'openclaw/default',
      'embedding-api-key': 'gateway-token',
      'source-fetch-mode': 'extract',
    });
    assert.deepEqual(settings.research.providers.embedding, {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:18789',
      model: 'openclaw/default',
      apiKey: 'gateway-token',
    });
    assert.equal(settings.research.sourceBased.fetchMode, 'extract');
  });
});
