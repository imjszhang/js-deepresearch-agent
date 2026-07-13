import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultSettings, mergeSettings } from 'js-deepresearch-engine';

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

  it('enables the quality source-based deep-research preset by default', () => {
    const settings = mergeSettings({});
    assert.equal(settings.research.questionsPerIteration, 2);
    assert.equal(settings.research.concurrency, 1);
    assert.equal(settings.research.budget.maxSearchRequests, 10);
    assert.equal(settings.research.budget.maxSourceReads, 12);
    assert.equal(settings.research.sourceBased.fetchMode, 'summary');
    assert.equal(settings.research.sourceBased.evidencePassages.enabled, true);
    assert.equal(settings.research.sourceBased.evidencePassages.claimAlignment, true);
    assert.equal(defaultSettings.research.sourceBased.queryMemory.enabled, true);
  });

  it('keeps semantic providers optional and deeply merges rerank overrides', () => {
    const settings = mergeSettings({ research: { providers: { rerank: { provider: 'jina', apiKey: 'key' } } } });
    assert.equal(defaultSettings.research.providers.embedding.provider, 'disabled');
    assert.equal(defaultSettings.research.providers.rerank.provider, 'rules');
    assert.equal(settings.research.providers.rerank.provider, 'jina');
    assert.equal(settings.research.providers.rerank.apiKey, 'key');
    assert.equal(settings.research.providers.rerank.timeoutMs, 30000);
  });
});
