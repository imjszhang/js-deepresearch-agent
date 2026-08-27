import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annotateBodyQuality, isSuccessfulBody, isWafOrErrorBody } from '../src/research/adaptive/body-quality.mjs';

describe('body quality', () => {
  it('treats Cloudflare and WAF shells as unsuccessful bodies', () => {
    const waf = 'Just a moment... Checking your browser before accessing hkexnews.hk. Cloudflare Ray ID: 123';
    assert.equal(isWafOrErrorBody(waf), true);
    assert.equal(isSuccessfulBody({ fetchStatus: 'ok', content: waf }), false);
    assert.equal(annotateBodyQuality({ fetchStatus: 'ok', content: waf }).fetchStatus, 'waf');
  });

  it('rejects empty or too-short bodies even when fetchStatus is ok', () => {
    assert.equal(isSuccessfulBody({ fetchStatus: 'ok', content: '' }), false);
    assert.equal(isSuccessfulBody({ fetchStatus: 'ok', content: 'short' }), false);
    assert.equal(isSuccessfulBody({
      fetchStatus: 'ok',
      content: 'Ollama is a tool for running local models.',
    }), true);
  });
});
