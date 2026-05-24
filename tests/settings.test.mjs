import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSettings } from '../src/config/defaults.mjs';

describe('settings defaults', () => {
  it('normalizes legacy SearXNG URL setting to a generic search base URL', () => {
    const settings = mergeSettings({
      search: {
        engine: 'searxng',
        searxngUrl: 'mock://legacy-search',
      },
    });

    assert.equal(settings.search.baseUrl, 'mock://legacy-search');
    assert.equal(settings.search.searxngUrl, undefined);
  });
});
