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
});
