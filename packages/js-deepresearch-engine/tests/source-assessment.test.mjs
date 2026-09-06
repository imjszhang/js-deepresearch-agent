import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessSourceBody,
  failClosedAssessment,
  normalizeSourceAssessment,
} from '../src/research/source-assessment.mjs';
import { classifyFetchedBody, isSuccessfulBody } from '../src/research/body-quality.mjs';
import { classifySourceTier } from '../src/research/adaptive/source-policy.mjs';

function assessmentJson(overrides = {}) {
  return JSON.stringify({
    summary: 'Official page describes current compliance filings.',
    readability: 'readable',
    contentKind: 'article',
    publisherType: 'official',
    firstParty: true,
    evidenceTier: 'other_primary',
    reason: 'readable official page',
    ...overrides,
  });
}

describe('source assessment', () => {
  it('normalizes a valid structured assessment and fail-closes invalid JSON', () => {
    const ok = normalizeSourceAssessment(JSON.parse(assessmentJson()));
    assert.equal(ok.method, 'llm');
    assert.equal(ok.readability, 'readable');
    assert.equal(normalizeSourceAssessment({ summary: 'x' }).method, 'fail_closed');
    // Nothing was judged, so the placeholder must not claim a readability verdict.
    assert.equal(failClosedAssessment().readability, 'uncertain');
  });

  it('retries once, then reports the assessment as unavailable without discarding the body', async () => {
    let calls = 0;
    const result = await assessSourceBody({
      llm: {
        async complete() {
          calls += 1;
          return calls === 1 ? 'not json' : '{"readability":"nope"}';
        },
      },
      content: 'garbled ciphertext ###@@@',
    });
    assert.equal(calls, 2);
    assert.equal(result.assessment.method, 'fail_closed');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.attempts, 2);
    assert.equal(result.retried, true);
    // The rule layer decides instead: this body is long enough and clean.
    const source = {
      fetchStatus: 'ok',
      assessmentStatus: 'unavailable',
      content: 'enough characters to look like a body '.repeat(4),
      assessment: result.assessment,
    };
    assert.equal(isSuccessfulBody(source), true);
    assert.equal(classifyFetchedBody(source).reason, 'body_ok');
  });

  it('marks LLM-unreadable bodies as unsuccessful without adding WAF needles', async () => {
    const result = await assessSourceBody({
      llm: {
        async complete() {
          return assessmentJson({
            summary: '',
            readability: 'unreadable',
            contentKind: 'obfuscated',
            publisherType: 'unknown',
            firstParty: false,
            evidenceTier: 'unknown',
            reason: 'encrypted blob',
          });
        },
      },
      content: 'AQIDBAUGBwgJCgsMDQ4PEA=='.repeat(8),
    });
    assert.equal(result.assessment.method, 'llm');
    assert.equal(classifyFetchedBody({
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      content: 'AQIDBAUGBwgJCgsMDQ4PEA=='.repeat(8),
      assessment: result.assessment,
    }).status, 'waf');
  });

  it('uses LLM evidenceTier for non-required hosts and keeps required hosts exact', () => {
    const reseller = {
      url: 'https://shop.example.com/zhipu',
      assessment: { evidenceTier: 'reprint', method: 'llm' },
    };
    assert.equal(classifySourceTier(reseller, { requiredHosts: [] }), 'reprint');
    assert.equal(classifySourceTier({
      url: 'https://zhipuai.cn/about',
      assessment: { evidenceTier: 'reprint', method: 'llm' },
    }, { requiredHosts: ['zhipuai.cn'] }), 'required_primary');
  });
});
