import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateEvidenceVerdict,
  buildClaimEvaluation,
  calculateQualityMetrics,
  extractQualityClaims,
  qualityGateFromClaims,
} from '../src/index.mjs';

function evidence(...verdicts) {
  return verdicts.map((verdict, index) => ({ verdict, score: 0.5 + index * 0.1, passageId: `p-${index}` }));
}

describe('quality metrics v2 claim extraction', () => {
  it('classifies fact claims, caveats, and recommendations while excluding sources', () => {
    const claims = extractQualityClaims(`# Report

## Summary
The system has a supported core conclusion with enough detail to evaluate.

## Key Findings
- A primary finding is backed by direct source evidence.

## Caveats
- Quantitative performance benchmarks remain unavailable.

## Recommendations
- Run a controlled benchmark before enabling the feature globally.

## Sources
- [2.1] Example source | https://example.com/source
- https://example.com/other
`);
    assert.deepEqual(claims.map((claim) => claim.kind), [
      'key_claim', 'key_claim', 'caveat', 'recommendation',
    ]);
    assert.equal(claims.some((claim) => claim.text.includes('example.com')), false);
  });

  it('splits substantial semicolon-separated facts and deduplicates repeats', () => {
    const claims = extractQualityClaims(`# Key Findings
First independent factual statement contains enough detail to evaluate; Second independent factual statement also contains enough detail to evaluate.
First independent factual statement contains enough detail to evaluate.
`);
    assert.equal(claims.length, 2);
    assert.ok(claims.every((claim) => claim.parentClaimText));
  });
});

describe('quality metrics v2 verdict aggregation', () => {
  const cases = [
    [['supported'], 'supported'],
    [['partially_supported'], 'partially_supported'],
    [['unsupported'], 'unsupported'],
    [['unverifiable'], 'unverifiable'],
    [[], 'unverifiable'],
    [['supported', 'unsupported'], 'conflicting'],
    [['partially_supported', 'unsupported'], 'conflicting'],
    [['supported', 'unverifiable'], 'supported'],
  ];

  for (const [input, expected] of cases) {
    it(`aggregates ${input.join('+') || 'no evidence'} as ${expected}`, () => {
      assert.equal(aggregateEvidenceVerdict(evidence(...input)).verdict, expected);
    });
  }

  it('counts claims rather than evidence edges and preserves the verdict invariant', () => {
    const claims = [
      { kind: 'key_claim', evidence: evidence('supported', 'supported', 'partially_supported') },
      { kind: 'supporting_claim', evidence: evidence('partially_supported') },
      { kind: 'supporting_claim', evidence: evidence('unsupported') },
      { kind: 'supporting_claim', evidence: [] },
      { kind: 'supporting_claim', evidence: evidence('supported', 'unsupported') },
      { kind: 'caveat', evidence: evidence('supported') },
    ].map((claim) => ({ ...claim, evaluation: buildClaimEvaluation(claim) }));
    const metrics = calculateQualityMetrics(claims);
    const total = Object.values(metrics.claims).reduce((sum, count) => sum + count, 0);
    assert.equal(metrics.claimCount, 6);
    assert.equal(metrics.evaluatedClaimCount, 5);
    assert.equal(total, metrics.evaluatedClaimCount);
    assert.deepEqual(metrics.claims, {
      supported: 1,
      partiallySupported: 1,
      unsupported: 1,
      unverifiable: 1,
      conflicting: 1,
    });
    assert.equal(metrics.caveatCount, 1);
  });

  it('returns null rates for empty denominators', () => {
    const metrics = calculateQualityMetrics([{ kind: 'caveat', evidence: [] }]);
    assert.equal(metrics.evaluatedClaimCount, 0);
    assert.equal(metrics.rates.supportedRate, null);
    assert.equal(metrics.rates.keyClaimSupportedRate, null);
  });

  it('derives the gate from key claims only', () => {
    const supported = { kind: 'key_claim', evidence: evidence('supported') };
    const partial = { kind: 'key_claim', evidence: evidence('partially_supported') };
    const conflict = { kind: 'key_claim', evidence: evidence('supported', 'unsupported') };
    assert.equal(qualityGateFromClaims([supported]), 'pass');
    assert.equal(qualityGateFromClaims([partial]), 'pass_with_warnings');
    assert.equal(qualityGateFromClaims([conflict]), 'fail');
  });
});
