import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSearchSettings, selectedBackendIds } from '../web/src/search-settings-form.mjs';

describe('web search settings form helpers', () => {
  it('builds a single-engine payload without inventing backends', () => {
    const search = buildSearchSettings({
      mode: 'single',
      engine: 'searxng',
      baseUrl: 'http://127.0.0.1:8080',
      maxResults: 8,
      previous: { engine: 'searxng' },
    });
    assert.equal(search.mode, 'single');
    assert.equal(search.engine, 'searxng');
    assert.equal(search.backends, undefined);
  });

  it('builds fan-out backends from selected engines and per-engine settings', () => {
    const search = buildSearchSettings({
      mode: 'fanout',
      engine: 'searxng',
      baseUrl: 'http://127.0.0.1:8080',
      maxResults: 12,
      maxParallelBackends: 2,
      selectedEngines: ['searxng', 'js-eyes'],
      backendConfigs: {
        searxng: { baseUrl: 'http://searx.local', maxResults: 6 },
        'js-eyes': { maxResults: 5, provider: { skills: ['js-zhihu-ops-skill'], serverUrl: 'ws://localhost:18080' } },
      },
      previous: {},
    });

    assert.equal(search.mode, 'fanout');
    assert.equal(search.maxResults, 12);
    assert.equal(search.fanout.maxParallelBackends, 2);
    assert.deepEqual(search.backends.map((item) => item.engine), ['searxng', 'js-eyes']);
    assert.equal(search.backends[0].settings.baseUrl, 'http://searx.local');
    assert.deepEqual(search.backends[1].settings.provider.skills, ['js-zhihu-ops-skill']);
    assert.deepEqual(selectedBackendIds(search), ['searxng', 'js-eyes']);
  });
});
