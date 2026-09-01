import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGapEvidence, needsSemanticClose } from '../src/research/gap-state.mjs';
import {
  applySlotSupportJudgments,
  failClosedSupport,
  judgeOpenSlotSupport,
} from '../src/research/gap-slot-support.mjs';

const SUBJECT_A_BODY = 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.';
const SUBJECT_B_BODY = 'SubjectB publishes a first-party guide at docs.example.com that states it remains experimental only.';
const UNRELATED_BODY = 'This long article discusses weather patterns, rainfall totals, and agricultural cycles without mentioning SubjectA or SubjectB.';

function slotGap(id, answerSlot) {
  return {
    id,
    question: `${answerSlot} official status`,
    answerSlot,
    kind: 'slot',
    requiredSlot: true,
    priority: 'normal',
    status: 'body_read',
    evidenceCriteria: ['official document', 'current status'],
  };
}

function finding(gapId, url, content) {
  return {
    gapId,
    sources: [{
      id: url,
      url,
      content,
      fetchStatus: 'ok',
    }],
  };
}

describe('gap slot support judgments', () => {
  it('supports a slot only when a verbatim body quote is anchored', async () => {
    const gaps = [slotGap('gap-2', 'SubjectA')];
    const findings = [finding('gap-2', 'https://docs.example.com/a', SUBJECT_A_BODY)];
    const result = await judgeOpenSlotSupport({
      query: 'What is SubjectA official status?',
      gaps,
      findings,
      llm: {
        async complete() {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'supported',
              quote: 'production support began in 2026',
              supportingPassageIds: ['body:https://docs.example.com/a'],
            }],
          });
        },
      },
    });
    applySlotSupportJudgments(gaps, result.judgments);
    const evaluated = evaluateGapEvidence(gaps[0], findings[0].sources, { slotSupport: gaps[0].slotSupport });
    assert.equal(evaluated.status, 'verified');
    assert.equal(evaluated.slotSupport.quoteAnchored, true);
  });

  it('keeps unrelated successful bodies at body_read', async () => {
    const gaps = [slotGap('gap-2', 'SubjectA')];
    const findings = [finding('gap-2', 'https://news.example.com/weather', UNRELATED_BODY)];
    const result = await judgeOpenSlotSupport({
      query: 'What is SubjectA official status?',
      gaps,
      findings,
      llm: {
        async complete() {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'unsupported',
              quote: 'weather patterns, rainfall totals, and agricultural cycles',
            }],
          });
        },
      },
    });
    applySlotSupportJudgments(gaps, result.judgments);
    const evaluated = evaluateGapEvidence(gaps[0], findings[0].sources, { slotSupport: gaps[0].slotSupport });
    assert.equal(evaluated.status, 'body_read');
    assert.ok(evaluated.missingEvidence.includes('slot_support'));
  });

  it('keeps partial support from closing a required slot', async () => {
    const gaps = [slotGap('gap-2', 'SubjectA')];
    const findings = [finding('gap-2', 'https://docs.example.com/a', SUBJECT_A_BODY)];
    const result = await judgeOpenSlotSupport({
      query: 'SubjectA status and performance numbers',
      gaps,
      findings,
      llm: {
        async complete() {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'partially_supported',
              quote: 'production support began in 2026',
            }],
          });
        },
      },
    });
    applySlotSupportJudgments(gaps, result.judgments);
    const evaluated = evaluateGapEvidence(gaps[0], findings[0].sources, { slotSupport: gaps[0].slotSupport });
    assert.equal(evaluated.status, 'body_read');
    assert.ok(evaluated.missingEvidence.includes('slot_partial'));
  });

  it('marks conflicting SubjectA and SubjectB evidence', async () => {
    const gap = slotGap('gap-2', 'SubjectA');
    const sources = [
      { url: 'https://docs.example.com/a', content: SUBJECT_A_BODY, fetchStatus: 'ok' },
      {
        url: 'https://docs.example.com/correction',
        content: SUBJECT_B_BODY,
        fetchStatus: 'ok',
        evidenceRole: 'contradicting',
      },
    ];
    const evaluated = evaluateGapEvidence(gap, sources, {
      slotSupport: { verdict: 'conflicting', quoteAnchored: true, method: 'llm' },
    });
    assert.equal(evaluated.status, 'conflicting');
  });

  it('rejects a forged quote and LLM timeout with fail-closed body_read', async () => {
    const gaps = [slotGap('gap-2', 'SubjectA')];
    const findings = [finding('gap-2', 'https://docs.example.com/a', SUBJECT_A_BODY)];
    const forged = await judgeOpenSlotSupport({
      query: 'SubjectA',
      gaps,
      findings,
      llm: {
        async complete() {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'supported',
              quote: 'this quote does not exist in the body at all',
            }],
          });
        },
      },
    });
    assert.equal(forged.judgments[0].method, 'fail_closed');
    applySlotSupportJudgments(gaps, forged.judgments);
    assert.equal(evaluateGapEvidence(gaps[0], findings[0].sources, { slotSupport: gaps[0].slotSupport }).status, 'body_read');

    const timedOut = await judgeOpenSlotSupport({
      query: 'SubjectA',
      gaps,
      findings,
      llm: {
        async complete() {
          throw new Error('timeout');
        },
      },
    });
    assert.equal(timedOut.judgments[0].method, 'fail_closed');
    assert.deepEqual(failClosedSupport('timeout').verdict, 'unverifiable');
  });

  it('does not treat a follow-up without requiredSlot as a semantic close', () => {
    const gap = { id: 'gap-9', question: 'side note', kind: 'followup', requiredSlot: false, status: 'searched' };
    assert.equal(needsSemanticClose(gap), false);
    const evaluated = evaluateGapEvidence(gap, [{
      url: 'https://docs.example.com/a',
      content: SUBJECT_A_BODY,
      fetchStatus: 'ok',
    }]);
    assert.equal(evaluated.status, 'verified');
  });
});
