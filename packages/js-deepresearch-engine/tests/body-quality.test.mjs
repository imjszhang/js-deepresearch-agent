import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFetchedBody,
  extractPublishedDate,
  isRawBinaryDocumentText,
  isSuccessfulBody,
  isWafOrErrorBody,
  MIN_FETCHED_BODY_CHARS,
  sourceHasObservableDate,
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
    assert.equal(isSuccessfulBody({
      fetchStatus: 'ok',
      content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
      assessment: { method: 'fail_closed', readability: 'unreadable' },
    }), false);
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
});
