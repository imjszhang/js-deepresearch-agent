import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSearchEngine } from '../src/index.mjs';
import { normalizeSearchConfig } from '../src/search/normalize-search-config.mjs';

describe('normalizeSearchConfig', () => {
  it('maps legacy searxngUrl to baseUrl', () => {
    const normalized = normalizeSearchConfig({
      engine: 'searxng',
      searxngUrl: 'http://127.0.0.1:8080',
    });

    assert.equal(normalized.baseUrl, 'http://127.0.0.1:8080');
    assert.equal(normalized.searxngUrl, undefined);
  });

  it('preserves explicit baseUrl over searxngUrl', () => {
    const normalized = normalizeSearchConfig({
      baseUrl: 'http://primary.local',
      searxngUrl: 'http://legacy.local',
    });

    assert.equal(normalized.baseUrl, 'http://primary.local');
    assert.equal(normalized.searxngUrl, undefined);
  });

  it('merges options without provider-specific fields', () => {
    const normalized = normalizeSearchConfig({
      engine: 'searxng',
      options: {
        language: 'zh',
      },
    });

    assert.equal(normalized.options.language, 'zh');
    assert.equal(normalized.provider, undefined);
  });

  it('normalizes legacy searxngUrl before createSearchEngine uses the adapter', () => {
    const engine = createSearchEngine({
      search: {
        engine: 'searxng',
        searxngUrl: 'http://legacy.local:8080',
      },
    });

    assert.equal(engine.config.baseUrl, 'http://legacy.local:8080');
    assert.equal(engine.config.searxngUrl, undefined);
  });
});
