import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SearxngSearchEngine } from '../src/search/engines/searxng.mjs';
import { getSearchMeta } from '../src/search/search-result.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SearxngSearchEngine searchOptions', () => {
  it('forwards run defaults and per-query overrides, and keeps provider metadata', async () => {
    let requested;
    globalThis.fetch = async (url) => {
      requested = new URL(url);
      return {
        ok: true,
        async json() {
          return {
            number_of_results: 12,
            suggestions: ['zhipu'],
            corrections: [],
            unresponsive_engines: [['google', 'timeout']],
            results: [{
              title: 'Official page',
              url: 'https://zhipuai.cn/about',
              content: 'Company overview',
              engines: ['brave'],
              category: 'general',
            }],
          };
        },
      };
    };

    const engine = new SearxngSearchEngine({
      baseUrl: 'http://127.0.0.1:8889',
      language: 'en',
      safeSearch: true,
      maxResults: 8,
      options: { engines: 'bing', language: 'en' },
    });
    const sources = await engine.search('智谱', {
      searchOptions: { engines: 'brave,google', language: 'zh', pageno: 2 },
    });

    assert.equal(requested.searchParams.get('q'), '智谱');
    assert.equal(requested.searchParams.get('engines'), 'brave,google');
    assert.equal(requested.searchParams.get('language'), 'zh');
    assert.equal(requested.searchParams.get('pageno'), '2');
    assert.deepEqual(sources[0].engines, ['brave']);
    const meta = getSearchMeta(sources);
    assert.equal(meta.numberOfResults, 12);
    assert.deepEqual(meta.suggestions, ['zhipu']);
    assert.deepEqual(meta.unresponsiveEngines, [['google', 'timeout']]);
    assert.deepEqual(meta.respondedEngines, ['brave']);
    assert.equal(meta.requestParams.engines, 'brave,google');
    assert.equal(JSON.stringify(sources).includes('requestParams'), false);
  });

  it('lets provider errors surface instead of rewriting language or engines', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      async text() { return 'Unknown language'; },
    });
    const engine = new SearxngSearchEngine({ baseUrl: 'http://127.0.0.1:8889' });
    await assert.rejects(
      () => engine.search('query', { searchOptions: { language: 'not-a-language' } }),
      /SearXNG search failed \(400\)/,
    );
  });
});
