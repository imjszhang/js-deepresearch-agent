import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFetchedBody,
  isSuccessfulBody,
  isWafOrErrorBody,
  MIN_FETCHED_BODY_CHARS,
} from '../src/research/body-quality.mjs';

describe('body quality helper', () => {
  it('treats Cloudflare and short fetched shells as unusable', () => {
    assert.equal(isWafOrErrorBody('Just a moment... Cloudflare'), true);
    assert.equal(isWafOrErrorBody('Access denied by administrator'), true);
    assert.equal(isWafOrErrorBody('ok '.repeat(20), { fetchClaimedOk: true, minChars: MIN_FETCHED_BODY_CHARS }), true);
    assert.equal(isWafOrErrorBody('Ollama is a local model runner used in tests.', { fetchClaimedOk: false }), false);
  });

  it('does not count WAF or empty pages as a successful body', () => {
    assert.equal(isSuccessfulBody({
      fetchStatus: 'ok',
      content: 'Just a moment... Cloudflare',
    }), false);
    assert.equal(classifyFetchedBody({
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      content: 'Enable JavaScript and wait.',
    }).status, 'waf');
    assert.equal(classifyFetchedBody({
      fetchStatus: 'ok',
      content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
    }).successful, true);
  });
});
