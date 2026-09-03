import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGapEvidence, needsSemanticClose } from '../src/research/gap-state.mjs';
import {
  applySlotSupportJudgments,
  collectSuccessfulPassages,
  failClosedSupport,
  judgeOpenSlotSupport,
  selectSlotPassages,
  slotSupportFingerprint,
} from '../src/research/gap-slot-support.mjs';
import { promoteSuccessfulSources } from '../src/research/slot-promotion.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';

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

  it('bounds body excerpts before sending them to the support judge', () => {
    const gap = slotGap('gap-2', 'SubjectA');
    const longBody = `${'Unrelated preface text. '.repeat(100)}${SUBJECT_A_BODY}${' Unrelated appendix text.'.repeat(100)}`;
    const selected = selectSlotPassages(
      gap,
      [finding('gap-2', 'https://docs.example.com/a', longBody)],
      { topK: 3, chunkChars: 600 },
    );

    assert.ok(selected.length > 0);
    assert.ok(selected.every((passage) => passage.text.length <= 600));
    assert.ok(selected.some((passage) => passage.text.includes('SubjectA publishes')));
  });

  it('splits a repeatedly truncated batch and preserves successful single-slot judgments', async () => {
    const gaps = [
      slotGap('gap-2', 'SubjectA'),
      slotGap('gap-3', 'SubjectB'),
    ];
    const findings = [
      finding('gap-2', 'https://docs.example.com/a', SUBJECT_A_BODY),
      finding('gap-3', 'https://docs.example.com/b', SUBJECT_B_BODY),
    ];
    const calls = [];
    const llm = {
      metadata: null,
      getLastCallMetadata() {
        return this.metadata;
      },
      async complete({ messages, maxTokens }) {
        const prompt = (messages || []).map((item) => item.content).join('\n');
        calls.push({ prompt, maxTokens });
        if (prompt.includes('Slot 2')) {
          this.metadata = { finishReason: 'length' };
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'supported',
              quote: 'production support began in 2026',
            }],
          });
        }
        this.metadata = { finishReason: 'stop' };
        const isSubjectA = prompt.includes('gapId: gap-2');
        return JSON.stringify({
          judgments: [{
            gapId: isSubjectA ? 'gap-2' : 'gap-3',
            verdict: 'supported',
            quote: isSubjectA
              ? 'production support began in 2026'
              : 'it remains experimental only',
          }],
        });
      },
    };

    const result = await judgeOpenSlotSupport({
      query: 'Compare SubjectA and SubjectB',
      gaps,
      findings,
      llm,
      batchSize: 2,
    });

    assert.equal(result.unknown, false);
    assert.equal(result.retried, true);
    assert.equal(result.batches, 1);
    assert.equal(result.splitRetries, 1);
    assert.equal(result.attempts, 4);
    assert.equal(result.judgments.length, 2);
    assert.ok(result.judgments.every((judgment) => judgment.method === 'llm' && judgment.quoteAnchored));
    assert.deepEqual(calls.map((call) => call.maxTokens), [1200, 1600, 800, 800]);
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

  it('reuses the same fingerprint instead of calling gap_support again', async () => {
    const gaps = [slotGap('gap-2', 'SubjectA')];
    const findings = [finding('gap-2', 'https://docs.example.com/a', SUBJECT_A_BODY)];
    const cache = new Map();
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        return JSON.stringify({
          judgments: [{
            gapId: 'gap-2',
            verdict: 'supported',
            quote: 'production support began in 2026',
          }],
        });
      },
    };
    const first = await judgeOpenSlotSupport({ query: 'SubjectA', gaps, findings, llm, cache });
    const second = await judgeOpenSlotSupport({ query: 'SubjectA', gaps, findings, llm, cache });
    assert.equal(calls, 1);
    assert.equal(first.cacheMisses, 1);
    assert.equal(second.cacheHits, 1);
    assert.equal(second.attempts, 0);
    assert.equal(second.judgments[0].verdict, 'supported');
    const changed = await judgeOpenSlotSupport({
      query: 'SubjectA',
      gaps,
      findings: [finding('gap-2', 'https://docs.example.com/a', `${SUBJECT_A_BODY} Updated 2026 filing.`)],
      llm,
      cache,
    });
    assert.equal(calls, 2);
    assert.equal(changed.cacheMisses, 1);
    assert.notEqual(
      slotSupportFingerprint(gaps[0], selectSlotPassages(gaps[0], findings)),
      slotSupportFingerprint(gaps[0], selectSlotPassages(gaps[0], changed.judgments ? [finding('gap-2', 'https://docs.example.com/a', `${SUBJECT_A_BODY} Updated 2026 filing.`)] : findings)),
    );
  });

  it('does not fallback a required slot to another slot body until it is promoted', () => {
    const commercial = slotGap('gap-commercial', 'commercialization');
    commercial.question = 'commercial revenue and customers';
    commercial.evidenceCriteria = ['revenue', 'customers'];
    const findings = [finding('gap-competition', 'https://example.test/revenue', 'The company reported commercial revenue and named enterprise customers in 2025.')];
    assert.equal(collectSuccessfulPassages(findings, {
      gapId: commercial.id,
      allowFallback: false,
    }).length, 0);
  });

  it('promotes a body read in a competing slot into dedicated commercial evidence', () => {
    const state = new ResearchState({
      query: 'company commercialization and competition',
      brief: { entities: ['SubjectA'] },
    });
    const commercial = state.addGap('commercial revenue and customers', 'normal', {
      id: 'gap-commercial',
      answerSlot: 'commercialization',
      requiredSlot: true,
      evidenceCriteria: ['revenue', 'customers'],
    });
    const source = {
      id: 'https://example.test/revenue',
      url: 'https://example.test/revenue',
      title: 'SubjectA commercial revenue',
      content: 'SubjectA reported commercial revenue and named enterprise customers in 2025.',
      fetchStatus: 'ok',
    };
    state.findings.push({
      gapId: 'gap-competition',
      sources: [source],
    });
    const promotions = promoteSuccessfulSources({
      state,
      sources: [source],
      discoveryGapId: 'gap-competition',
      entities: ['SubjectA'],
    });
    assert.ok(promotions.some((item) => item.targetGapId === commercial.id));
    assert.ok(collectSuccessfulPassages(state.findings, {
      gapId: commercial.id,
      allowFallback: false,
    }).length > 0);
  });

  it('reopens a blocked required slot after an independent matching body is promoted', () => {
    const state = new ResearchState({
      query: '智谱AI 股权结构',
      brief: { entities: ['智谱AI'], entityAliases: ['Zhipu AI', '智谱'] },
    });
    const ownership = state.addGap('What is the ownership structure?', 'critical', {
      id: 'gap-ownership',
      answerSlot: 'ownership',
      requiredSlot: true,
      evidenceCriteria: ['shareholder', 'equity'],
    });
    ownership.status = 'blocked';
    ownership.blockedReason = 'repair_exhausted';
    const source = {
      id: 'https://www1.hkexnews.hk/zhipu.htm',
      url: 'https://www1.hkexnews.hk/zhipu.htm',
      title: '智谱AI 招股书',
      content: '智谱AI招股说明书披露控股股东与股权结构，并列出主要股东持股比例。'.repeat(2),
      fetchStatus: 'ok',
    };
    state.addCandidates([source], 'gap-discovery');
    state.candidates.get(source.id).relevanceDecisionByGap = {
      [ownership.id]: {
        accepted: true,
        reasonCode: 'relevance_accepted',
        rerankScore: 0.9,
      },
    };
    const promotions = promoteSuccessfulSources({
      state,
      sources: [source],
      discoveryGapId: 'gap-discovery',
      entities: ['智谱AI'],
      entityAliases: ['Zhipu AI', '智谱'],
    });
    assert.ok(promotions.some((item) => item.targetGapId === ownership.id));
    assert.notEqual(ownership.status, 'blocked');
    assert.equal(ownership.blockedReason, null);
  });

  it('does not promote a product body into ownership from a broad original query', () => {
    const state = new ResearchState({
      query: '全面研究智谱AI：股权结构、产品、商业化与竞争格局',
      brief: { entities: ['智谱AI'], entityAliases: ['智谱'] },
    });
    const ownership = state.addGap('What is the ownership structure?', 'critical', {
      id: 'gap-ownership',
      answerSlot: 'ownership',
      requiredSlot: true,
      evidenceCriteria: ['shareholder', 'equity'],
    });
    const source = {
      id: 'https://example.test/product',
      url: 'https://example.test/product',
      title: '智谱AI 产品',
      content: '智谱AI发布新的大模型产品和API服务，提供企业级产品能力。',
      fetchStatus: 'ok',
    };
    const promotions = promoteSuccessfulSources({
      state,
      sources: [source],
      discoveryGapId: 'gap-product',
      entities: ['智谱AI'],
      entityAliases: ['智谱'],
    });
    assert.equal(promotions.some((item) => item.targetGapId === ownership.id), false);
  });
});
