import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSearchEngine,
  getContentFetchHandlers,
  searchEngineMetadata,
} from 'js-deepresearch-engine';
import '../src/search-providers/register-local-search-engines.mjs';

describe('local search engine registration', () => {
  it('registers js-eyes as an app-local provider', () => {
    const entry = searchEngineMetadata.find((item) => item.id === 'js-eyes');
    assert.ok(entry);
    assert.equal(entry.label, 'JS Eyes');
    assert.equal(entry.requiresBrowser, true);
    assert.equal(entry.maxQuestionConcurrency, 1);
  });

  it('creates a fan-out composite from searxng and js-eyes backends', () => {
    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        maxResults: 12,
        backends: [
          { id: 'web', engine: 'searxng', enabled: true, settings: { baseUrl: 'http://searx.local', maxResults: 6 } },
          {
            id: 'community',
            engine: 'js-eyes',
            enabled: true,
            settings: { maxResults: 5, provider: { skills: ['js-zhihu-ops-skill'] } },
          },
        ],
      },
    });

    assert.equal(engine.kind, 'composite');
    assert.equal(engine.backends.length, 2);
    assert.equal(engine.backends[0].instance.config.baseUrl, 'http://searx.local');
    assert.equal(engine.backends[1].instance.capabilities.maxQuestionConcurrency, 1);
    assert.equal(engine.capabilities.maxQuestionConcurrency, 1);
  });

  it('creates the registered js-eyes engine through the factory', async () => {
    const engine = createSearchEngine({
      search: {
        engine: 'js-eyes',
        provider: {
          skills: ['js-x-ops-skill'],
        },
      },
    });

    assert.equal(typeof engine.search, 'function');
    assert.equal(engine.capabilities.maxQuestionConcurrency, 1);
  });

  it('registers zhihu content fetch handler at startup', () => {
    assert.ok(getContentFetchHandlers().length >= 1);
  });
});
