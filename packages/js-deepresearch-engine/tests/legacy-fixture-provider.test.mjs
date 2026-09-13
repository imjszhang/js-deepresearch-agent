import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { legacyFixtureLlm } from './helpers/legacy-research-runner.mjs';

describe('legacy offline fixture usage', () => {
  it('declares requested synthetic allocation for string-only scripts', async () => {
    const provider = { async complete() { return 'fixture response'; } };
    const llm = legacyFixtureLlm(provider, { llm: { maxTokens: 700 }, research: { budget: { maxLlmTokens: 20000 } } });
    assert.deepEqual(await llm.completeWithMetadata({ maxTokens: 300 }), {
      text: 'fixture response', usage: { totalTokens: 300 }, metadata: { syntheticFixtureUsage: true },
    });
    assert.equal((await llm.completeWithMetadata({ maxTokens: 0, purpose: 'report' })).usage.totalTokens, 1);
    assert.equal((await llm.completeWithMetadata({})).usage.totalTokens, 700);
    assert.equal(provider.completeWithMetadata, undefined);
    const exhaustedScript = legacyFixtureLlm({ async complete() {} });
    assert.deepEqual((await exhaustedScript.completeWithMetadata({ maxTokens: 300 })).usage, { totalTokens: 300 });
  });

  it('preserves explicit metadata providers and object responses with unknown usage', async () => {
    const unknown = { text: 'invalid structured response' };
    const provider = { async complete() { return 'unused'; }, async completeWithMetadata() { return unknown; } };
    assert.equal(legacyFixtureLlm(provider), provider);
    assert.equal(await legacyFixtureLlm(provider).completeWithMetadata({}), unknown);
    const objectProvider = legacyFixtureLlm({ async complete() { return unknown; } });
    assert.equal(await objectProvider.completeWithMetadata({}), unknown);
  });

  it('preserves scripted errors without inventing completed usage', async () => {
    const failure = Object.assign(new Error('unknown call'), { code: 'LLM_USAGE_UNKNOWN' });
    const llm = legacyFixtureLlm({ async complete() { throw failure; } });
    await assert.rejects(llm.completeWithMetadata({}), actual => actual === failure);
  });
});
