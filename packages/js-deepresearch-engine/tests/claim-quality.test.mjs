import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAIM_EVALUATION_VERSION,
  CLAIM_EXTRACTION_VERSION,
  aggregateEvidenceVerdict,
  buildClaimEvaluation,
  calculateQualityMetrics,
  extractQualityClaims,
  qualityGateFromClaims,
  splitAtomicClaimTexts,
} from '../src/index.mjs';

function evidence(...verdicts) {
  return verdicts.map((verdict, index) => ({ verdict, score: 0.5 + index * 0.1, passageId: `p-${index}` }));
}

describe('quality metrics v3 claim extraction', () => {
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

  it('splits a Summary paragraph into independently verifiable atoms with parent links', () => {
    const claims = extractQualityClaims(`# Summary
Ollama is an independent company developing local LLM tools [1.2]. It also offers cloud-hosted models for teams [1.2]. The project reports more than one hundred thousand developers [1.2].
`);
    assert.ok(claims.length >= 3);
    assert.ok(claims.every((claim) => claim.section === 'Summary'));
    assert.ok(claims.every((claim) => claim.lineStart === 2));
    assert.ok(claims.every((claim) => claim.kind === 'key_claim'));
    assert.ok(claims.every((claim) => claim.parentClaimText));
    assert.ok(claims.every((claim) => claim.citationKeys.includes('1.2')));
    const metrics = calculateQualityMetrics(claims.map((claim) => ({
      ...claim,
      evidence: [],
      evaluation: buildClaimEvaluation({ ...claim, evidence: [] }),
    })));
    assert.equal(metrics.evaluatedClaimCount, claims.length);
    assert.equal(metrics.claimExtractionVersion, CLAIM_EXTRACTION_VERSION);
    assert.equal(CLAIM_EXTRACTION_VERSION, 3);
    assert.equal(CLAIM_EVALUATION_VERSION, 3);
  });

  it('keeps a trailing citation after a period with the preceding fact', () => {
    const atoms = splitAtomicClaimTexts('Local-first AI keeps user data on devices. [1.1]');
    assert.equal(atoms.length, 1);
    assert.deepEqual(atoms[0].citationKeys, ['1.1']);
    assert.match(atoms[0].text, /\[1\.1\]/);
  });

  it('does not split versions, decimals, URLs, citations, or abbreviations', () => {
    const text = 'The model reports 195.6 tokens/sec on v1.2.3 at https://example.com/docs?v=1.2 and cites [1.2] in the README, e.g. the official guide.';
    const atoms = splitAtomicClaimTexts(text);
    assert.equal(atoms.length, 1);
    assert.match(atoms[0].text, /195\.6 tokens\/sec/);
    assert.match(atoms[0].text, /v1\.2\.3/);
    assert.match(atoms[0].text, /https:\/\/example.com\/docs\?v=1\.2/);
    assert.deepEqual(atoms[0].citationKeys, ['1.2']);
  });

  it('does not double-count a parent statement when child atoms exist', () => {
    const parentText = 'Alpha fact is independently verifiable here. Beta fact is independently verifiable here. Gamma fact is independently verifiable here.';
    const children = extractQualityClaims(`# Summary\n${parentText}\n`);
    assert.ok(children.length >= 3);
    const claims = [
      {
        kind: 'key_claim',
        text: parentText,
        evidence: [],
        evaluation: buildClaimEvaluation({ evidence: [] }),
      },
      ...children.map((claim) => ({
        ...claim,
        evidence: [],
        evaluation: buildClaimEvaluation({ evidence: [] }),
      })),
    ];
    const metrics = calculateQualityMetrics(claims);
    assert.equal(metrics.evaluatedClaimCount, children.length);
    assert.equal(metrics.claimCount, children.length);
  });
});

describe('quality metrics v3 verdict aggregation', () => {
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
    assert.equal(qualityGateFromClaims([]), 'fail');
    assert.equal(qualityGateFromClaims([{ kind: 'caveat', evidence: [] }]), 'fail');
  });
});
