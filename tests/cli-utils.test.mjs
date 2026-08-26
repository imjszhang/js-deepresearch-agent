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
    const parsed = parseArgs(['hello', 'world', '--strategy', 'quick', '--json']);
    assert.deepEqual(parsed.args, ['hello', 'world']);
    assert.equal(parsed.flags.strategy, 'quick');
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

  it('maps focused enrichment flags into research settings', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'focused-fetch-mode': 'summary',
      'focused-max-urls': '12',
      'focused-enable-filter': 'true',
      'focused-max-sources': '20',
    });

    assert.equal(settings.research.focused.fetchMode, 'summary');
    assert.equal(settings.research.focused.maxUrlsTotal, 12);
    assert.equal(settings.research.focused.enableRelevanceFilter, true);
    assert.equal(settings.research.focused.maxSourcesForReport, 20);
  });

  it('maps focused fetch backend flag into research settings', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'focused-fetch-backend': 'js-eyes',
    });

    assert.equal(settings.research.focused.fetchBackend, 'js-eyes');
  });

  it('defaults quick research to a single iteration unless --iterations is set', () => {
    const implied = applyResearchFlags({ research: { iterations: 2 } }, { strategy: 'quick' });
    assert.equal(implied.research.strategy, 'quick');
    assert.equal(implied.research.iterations, 1);

    const explicit = applyResearchFlags({ research: { iterations: 2 } }, { strategy: 'quick', iterations: '3' });
    assert.equal(explicit.research.iterations, 3);

    const focused = applyResearchFlags({ research: { iterations: 2 } }, { strategy: 'focused' });
    assert.equal(focused.research.iterations, 2);
  });

  it('rejects retired strategy IDs with a migration hint', () => {
    assert.throws(
      () => applyResearchFlags({ research: {} }, { strategy: 'source-based' }),
      /Strategy "source-based" is no longer supported.*focused/,
    );
    assert.throws(
      () => applyResearchFlags({ research: {} }, { strategy: 'rapid' }),
      /Strategy "rapid" is no longer supported.*quick/,
    );
    assert.throws(
      () => applyResearchFlags({ research: {} }, { 'adaptive-loop-version': 'v2' }),
      /--adaptive-loop-version has been removed/,
    );
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
      strategy: 'exploratory',
      'max-search-requests': '12',
      'max-source-reads': '5',
      'focused-iteration-control': 'true',
      'focused-query-memory': 'false',
      'focused-cluster-results': 'true',
      'focused-evidence-passages': 'true',
      'focused-claim-alignment': 'true',
      'focused-pre-report-gate': 'true',
    });
    assert.equal(settings.research.strategy, 'exploratory');
    assert.equal(settings.research.budget.maxSearchRequests, 12);
    assert.equal(settings.research.budget.maxSourceReads, 5);
    assert.equal(settings.research.focused.iterationControl.enabled, true);
    assert.equal(settings.research.focused.queryMemory.enabled, false);
    assert.equal(settings.research.focused.sourceSelection.enabled, true);
    assert.equal(settings.research.focused.evidencePassages.claimAlignment, true);
    assert.equal(settings.research.focused.preReportGate.enabled, true);
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
      'exploratory-max-steps': '12',
      'exploratory-min-llm-tokens': '18000',
      'exploratory-max-llm-tokens': '72000',
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
    assert.equal(settings.research.exploratory.maxSteps, 12);
    assert.equal(settings.research.exploratory.minLlmTokens, 18000);
    assert.equal(settings.research.exploratory.maxLlmTokens, 72000);
    assert.equal(settings.research.exploratory.targetLlmTokens, 18000);
  });

  it('maps legacy exploratory-target-llm-tokens onto the min floor', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'exploratory-target-llm-tokens': '15000',
    });
    assert.equal(settings.research.exploratory.minLlmTokens, 15000);
    assert.equal(settings.research.exploratory.targetLlmTokens, 15000);
  });

  it('maps embedding and extract fetch mode flags', () => {
    const settings = applyResearchFlags({ research: {} }, {
      'embedding-provider': 'openai-compatible',
      'embedding-base-url': 'http://127.0.0.1:18789',
      'embedding-model': 'openclaw/default',
      'embedding-api-key': 'gateway-token',
      'focused-fetch-mode': 'extract',
    });
    assert.deepEqual(settings.research.providers.embedding, {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:18789',
      model: 'openclaw/default',
      apiKey: 'gateway-token',
    });
    assert.equal(settings.research.focused.fetchMode, 'extract');
  });

  it('maps http-proxy flag without persisting it', () => {
    const settings = applyResearchFlags({}, {
      'http-proxy': 'socks5://127.0.0.1:1080',
    });
    assert.equal(settings.http.proxy, 'socks5://127.0.0.1:1080');
  });
});
