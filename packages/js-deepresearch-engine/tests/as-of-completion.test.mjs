import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAsOfGate, resolveCompletionStatus, sourceUsableForAsOf } from '../src/research/as-of.mjs';
import { sanitizeAsOf, sanitizeResearchBrief } from '../src/research/research-brief.mjs';
import { applyClaimEntailment } from '../src/research/claim-entailment.mjs';

describe('as-of and completion status', () => {
  it('sanitizes structured asOf without inferring dates from prose', () => {
    const brief = sanitizeResearchBrief({
      query: '截至2026年8月研究智谱',
      asOf: { date: '2026-08-31', source: 'user' },
      entityAliases: ['Zhipu AI'],
    });
    assert.deepEqual(brief.asOf, { date: '2026-08-31', source: 'user', label: '2026-08-31' });
    assert.deepEqual(brief.entityAliases, ['Zhipu AI']);
    assert.equal(sanitizeResearchBrief({ query: '截至2026年8月研究智谱' }).asOf, null);
  });

  it('treats YYYY-MM as the inclusive last day of that month', () => {
    assert.equal(sanitizeResearchBrief({ query: 'q', asOf: '2026-08' }).asOf.date, '2026-08-31');
    assert.equal(sanitizeResearchBrief({ query: 'q', asOf: { date: '2026-02' } }).asOf.date, '2026-02-28');
    assert.equal(sanitizeResearchBrief({
      query: 'q',
      asOf: { date: '2026-08-31', source: 'planner', label: '截至2026年8月' },
    }).asOf.label, '截至2026年8月');
  });

  it('rejects impossible dates and trailing date text', () => {
    assert.equal(sanitizeAsOf('2026-02-31'), null);
    assert.equal(sanitizeAsOf('2026-08-31garbage'), null);
    assert.equal(sanitizeAsOf('2024-02-29').date, '2024-02-29');
    assert.equal(sanitizeAsOf('2025-02-29'), null);
  });

  it('fails closed on post-cutoff or undated key claims', () => {
    assert.equal(sourceUsableForAsOf({ publishedAt: '2026-09-02' }, { date: '2026-08-31' }).reason, 'post_cutoff');
    assert.equal(sourceUsableForAsOf({ title: 'No date' }, { date: '2026-08-31' }).reason, 'unknown_date');
    const claims = applyAsOfGate([{
      kind: 'key_claim',
      text: 'Revenue was 950 million',
      citedSourceIds: ['src-1'],
      flags: [],
      evidence: [{ sourceId: 'src-1', passageId: 'p1', verdict: 'supported' }],
    }], {
      asOf: { date: '2026-08-31' },
      sources: [{ id: 'src-1', publishedAt: '2026-09-10', content: 'September update' }],
      passages: [{ id: 'p1', sourceId: 'src-1', text: 'September update about later funding' }],
    });
    assert.equal(claims[0].evaluation.verdict, 'unverifiable');
    assert.ok(claims[0].flags.includes('as_of_incompatible'));
  });

  it('keeps safety_cap with open required slots incomplete beside the legacy gate', () => {
    assert.equal(resolveCompletionStatus({
      readiness: { pass: false },
      stopReason: 'safety_cap',
      gaps: [{ id: 'gap-2', requiredSlot: true, status: 'body_read' }],
    }), 'incomplete');
    assert.equal(resolveCompletionStatus({
      readiness: { pass: true },
      stopReason: 'evidence_sufficient',
      gaps: [{ id: 'gap-2', requiredSlot: true, status: 'verified' }],
    }), 'complete');
    assert.equal(resolveCompletionStatus({
      readiness: null,
      stopReason: null,
      gaps: [],
    }), 'complete');
  });

  it('reuses claim entailment judgments for the same text and passage fingerprint', async () => {
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        return JSON.stringify({
          verdict: 'supported',
          quote: 'production support began in 2026',
        });
      },
    };
    const passages = [{
      id: 'p1',
      sourceId: 'src-1',
      text: 'The vendor said production support began in 2026 for paying customers.',
    }];
    const claim = {
      kind: 'key_claim',
      text: 'Production support began in 2026.',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-1'],
      flags: [],
      evaluation: { verdict: 'partially_supported', flags: [] },
    };
    const cache = new Map();
    await applyClaimEntailment([claim, { ...claim }], {
      llm,
      passages,
      mode: 'rules_then_llm',
      cache,
    });
    assert.equal(calls, 1);
  });
});
