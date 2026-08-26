import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyClaimEntailment,
  applyEntailmentVerdict,
  shouldJudgeClaim,
} from '../src/index.mjs';

const passage = {
  id: 'p-1',
  sourceId: 's-1',
  text: 'MLX 是 Apple Machine Learning Research 发布的开源数组框架，专为 Apple Silicon 的统一内存架构设计。',
};

function baseClaim(overrides = {}) {
  return {
    kind: 'key_claim',
    text: 'MLX 针对 Apple Silicon 统一内存做了优化。',
    citationKeys: ['1.1'],
    citedSourceIds: ['s-1'],
    flags: [],
    evaluation: { verdict: 'unverifiable' },
    evidence: [{ passageId: 'p-1', sourceId: 's-1', verdict: 'unverifiable', score: 0.05, method: 'rules' }],
    ...overrides,
  };
}

describe('claim entailment gating', () => {
  it('does not judge supported, uncited, or snippet-only claims', () => {
    assert.equal(shouldJudgeClaim(baseClaim({ evaluation: { verdict: 'supported' } }), [passage]), false);
    assert.equal(shouldJudgeClaim(baseClaim({ citationKeys: [], flags: ['uncited'] }), [passage]), false);
    assert.equal(shouldJudgeClaim(baseClaim({ flags: ['snippet_only'] }), [passage]), false);
    assert.equal(shouldJudgeClaim(baseClaim({ flags: ['missing_direct_evidence'] }), [passage]), false);
    assert.equal(shouldJudgeClaim(baseClaim(), [passage]), true);
  });

  it('keeps the rule verdict when the quote is not in the passage', () => {
    const next = applyEntailmentVerdict(
      baseClaim(),
      { verdict: 'supported', quote: 'this quote is not present in the source body' },
      [passage],
    );
    assert.equal(next.evaluation.verdict, 'unverifiable');
  });

  it('accepts a Chinese paraphrase when the quote matches a cited passage', () => {
    const next = applyEntailmentVerdict(
      baseClaim(),
      { verdict: 'supported', quote: '专为 Apple Silicon 的统一内存架构设计' },
      [passage],
    );
    assert.equal(next.evaluation.verdict, 'supported');
    assert.equal(next.evaluation.method, 'llm');
    assert.equal(next.evaluation.origin, 'runtime_llm');
  });

  it('does not call the LLM for already supported claims', async () => {
    let calls = 0;
    const judged = await applyClaimEntailment([
      baseClaim({ evaluation: { verdict: 'supported' } }),
    ], {
      mode: 'rules_then_llm',
      passages: [passage],
      llm: { async complete() { calls += 1; return '{"verdict":"supported","quote":"专为 Apple Silicon 的统一内存架构设计"}'; } },
    });
    assert.equal(calls, 0);
    assert.equal(judged[0].evaluation.verdict, 'supported');
  });

  it('skips LLM entirely in rules mode', async () => {
    let calls = 0;
    await applyClaimEntailment([baseClaim()], {
      mode: 'rules',
      passages: [passage],
      llm: { async complete() { calls += 1; return '{}'; } },
    });
    assert.equal(calls, 0);
  });

  it('calls the LLM for mid-overlap cited claims and applies a matching quote', async () => {
    let calls = 0;
    const judged = await applyClaimEntailment([baseClaim()], {
      mode: 'rules_then_llm',
      passages: [passage],
      llm: {
        async complete({ purpose }) {
          calls += 1;
          assert.equal(purpose, 'claim_entailment');
          return '{"verdict":"supported","quote":"专为 Apple Silicon 的统一内存架构设计"}';
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(judged[0].evaluation.verdict, 'supported');
  });
});
