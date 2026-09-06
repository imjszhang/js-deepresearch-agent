import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFetchedBody,
  extractPublishedDate,
  isRawBinaryDocumentText,
  isRetryableReadFailure,
  isSuccessfulBody,
  isTransportReadFailure,
  isWafOrErrorBody,
  sanitizeUnusableSourceBody,
  MIN_FETCHED_BODY_CHARS,
  sourceHasObservableDate,
  transportFailureReason,
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

  it('does not count raw PDF object streams as a successful body', () => {
    const rawPdf = '%PDF-1.5\n1 0 obj\n<</Lang(zh-TW)/Metadata 2 0 R/Type/Catalog>>\nendobj\n';
    assert.equal(isRawBinaryDocumentText(rawPdf), true);
    assert.equal(isSuccessfulBody({
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      content: rawPdf,
    }), false);
    assert.equal(classifyFetchedBody({
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      content: rawPdf,
    }).reason, 'raw_document_bytes');
  });

  it('extracts observable dates from titles and body text', () => {
    assert.equal(extractPublishedDate('Updated 2026-03-31 in the article body'), '2026-03-31');
    assert.equal(extractPublishedDate('发布于2026年3月31日的官方说明'), '2026-03-31');
    assert.equal(sourceHasObservableDate({
      title: 'No date field',
      content: 'The filing published 2026-03-31 includes revenue and shareholder tables.',
    }), true);
    assert.equal(classifyFetchedBody({
      fetchStatus: 'ok',
      content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
      assessment: { method: 'llm', readability: 'unreadable', reason: 'obfuscated' },
    }).reason, 'assessment_unreadable');
    assert.equal(sourceHasObservableDate({
      title: 'Undated note',
      content: 'A successful body without any calendar date.',
    }), false);
  });

  it('falls back to the rule layer when the assessment never returned a verdict', () => {
    const fetched = {
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      assessmentStatus: 'unavailable',
      assessment: { method: 'fail_closed', readability: 'uncertain', reason: 'invalid_or_empty_json' },
    };
    const usable = {
      ...fetched,
      content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
    };
    assert.equal(isSuccessfulBody(usable), true);
    assert.equal(classifyFetchedBody(usable).successful, true);

    const shell = { ...fetched, content: 'Just a moment... Cloudflare' };
    assert.equal(isSuccessfulBody(shell), false);
    assert.equal(classifyFetchedBody(shell).reason, 'waf_or_shell');
  });

  it('separates transport refusals from semantic read failures', () => {
    assert.equal(isTransportReadFailure(
      { fetchStatus: 'failed', httpStatus: 403, fetchErrorType: 'http_4xx' },
      { status: 'failed', successful: false },
    ), true);
    assert.equal(isTransportReadFailure(
      { fetchStatus: 'failed', fetchErrorType: 'timeout' },
      { status: 'failed', successful: false },
    ), true);
    assert.equal(isTransportReadFailure(
      { fetchStatus: 'ok', contentOrigin: 'fetched' },
      { status: 'waf', successful: false, reason: 'waf_or_shell' },
    ), true);
    // An LLM verdict is a content judgment, not a transport fact.
    assert.equal(isTransportReadFailure(
      { fetchStatus: 'ok' },
      { status: 'waf', successful: false, reason: 'assessment_unreadable' },
    ), false);
    assert.equal(isTransportReadFailure(
      { fetchStatus: 'irrelevant' },
      { status: 'irrelevant', successful: false },
    ), false);
    assert.equal(isTransportReadFailure({ fetchStatus: 'ok' }, { status: 'read', successful: true }), false);

    assert.equal(transportFailureReason({ httpStatus: 403 }, { status: 'failed' }), 'http_403');
    assert.equal(transportFailureReason({ fetchErrorType: 'timeout' }, { status: 'failed' }), 'timeout');
    assert.equal(transportFailureReason({}, { status: 'waf' }), 'challenge');
  });

  it('does not let an LLM unreadable verdict rewrite the transport status', () => {
    const cleaned = sanitizeUnusableSourceBody({
      url: 'https://zhipuai.cn/about',
      content: 'Body that the model called unreadable.',
      fetchStatus: 'ok',
    }, { status: 'waf', successful: false, reason: 'assessment_unreadable' });
    assert.equal(cleaned.content, '');
    assert.equal(cleaned.fetchStatus, 'ok');
    assert.equal(cleaned.bodyQuality, 'waf');
  });

  it('keeps WAF diagnostics and strips the fake fetched body', () => {
    const quality = classifyFetchedBody({
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      content: 'Just a moment... Cloudflare',
      snippet: 'HKEX filing snippet',
    });
    const cleaned = sanitizeUnusableSourceBody({
      url: 'https://www1.hkexnews.hk/a.htm',
      title: 'Filing',
      content: 'Just a moment... Cloudflare',
      snippet: 'HKEX filing snippet',
      fetchStatus: 'ok',
    }, quality);
    assert.equal(cleaned.content, '');
    assert.equal(cleaned.summary, '');
    assert.equal(cleaned.snippet, 'HKEX filing snippet');
    assert.equal(cleaned.fetchStatus, 'waf');
    assert.equal(cleaned.accessNotes, 'waf_or_shell');
  });

  it('treats failed and WAF fetches as retryable, but not successful or irrelevant bodies', () => {
    assert.equal(isRetryableReadFailure({ status: 'failed', successful: false }), true);
    assert.equal(isRetryableReadFailure({ status: 'waf', successful: false }), true);
    assert.equal(isRetryableReadFailure({ status: 'irrelevant', successful: false }), false);
    assert.equal(isRetryableReadFailure({ status: 'read', successful: true }), false);
  });
});
