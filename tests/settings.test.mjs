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

  it('enables the quality focused deep-research preset by default', () => {
    const settings = mergeSettings({});
    assert.equal(settings.research.strategy, 'focused');
    assert.equal(settings.research.questionsPerIteration, 2);
    assert.equal(settings.research.concurrency, 1);
    assert.equal(settings.research.budget.maxSearchRequests, 18);
    assert.equal(settings.research.budget.maxSourceReads, 16);
    assert.equal(settings.research.focused.fetchMode, 'summary');
    assert.equal(settings.research.focused.evidencePassages.enabled, true);
    assert.equal(settings.research.focused.evidencePassages.claimAlignment, true);
    assert.equal(settings.research.focused.iterationControl.enabled, true);
    assert.equal(defaultSettings.research.focused.queryMemory.enabled, true);
    assert.equal(settings.research.sourceBased, undefined);
    assert.equal(settings.research.adaptive, undefined);
    assert.equal(settings.research.exploratory.minLlmTokens, 60000);
    assert.equal(settings.research.exploratory.maxLlmTokens, 200000);
    assert.equal(settings.research.exploratory.minLlmTokens, 60000);
    assert.equal(settings.research.exploratory.maxLlmTokens, 200000);
    assert.equal(settings.research.exploratory.targetLlmTokens, 60000);
    assert.equal(settings.research.exploratory.maxSteps, 0);
    assert.equal(settings.research.exploratory.maxSearchRequests, 0);
    assert.equal(settings.research.exploratory.maxSourceReads, 0);
    assert.equal(settings.research.quality.entailment, 'rules_then_llm');
    assert.equal(settings.research.report.maxOutputTokens, 0);
    assert.equal(settings.research.budget.maxTotalLlmTokens, 0);
    assert.equal(settings.research.budget.reserveReportTokens, 0);
  });

  it('treats a persisted target of 0 as an explicit disabled token floor', () => {
    const settings = mergeSettings({
      research: { exploratory: { targetLlmTokens: 0 } },
    });
    assert.equal(settings.research.exploratory.minLlmTokens, 0);
    assert.equal(settings.research.exploratory.targetLlmTokens, 0);
  });

  it('migrates persisted source-based and adaptive settings to live keys', () => {
    const settings = mergeSettings({
      research: {
        strategy: 'adaptive',
        sourceBased: {
          fetchMode: 'full',
          adaptiveControl: { enabled: false, maxIterations: 2 },
        },
        adaptive: { loopVersion: 'v2', maxSteps: 9 },
      },
    });
    assert.equal(settings.research.strategy, 'exploratory');
    assert.equal(settings.research.focused.fetchMode, 'full');
    assert.equal(settings.research.focused.iterationControl.enabled, false);
    assert.equal(settings.research.focused.iterationControl.maxIterations, 2);
    assert.equal(settings.research.exploratory.maxSteps, 9);
    assert.equal(settings.research.exploratory.loopVersion, undefined);
    assert.equal(settings.research.sourceBased, undefined);
    assert.equal(settings.research.adaptive, undefined);
  });

  it('maps adaptive v1 persisted strategy to focused', () => {
    const settings = mergeSettings({
      research: { strategy: 'adaptive', adaptive: { loopVersion: 'v1', maxSteps: 8 } },
    });
    assert.equal(settings.research.strategy, 'focused');
    assert.equal(settings.research.exploratory.maxSteps, 8);
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
