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
  slotsNeedingSupport,
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

  it('anchors an HTML-encoded source quote and preserves prior anchored support on a later judge failure', async () => {
    const gaps = [slotGap('gap-2', 'commerce_judgment')];
    const findings = [finding(
      'gap-2',
      'https://claude.com/solutions/commerce',
      'Go live before code freeze to capture this year&#x27;s traffic. Your relationships stay yours.',
    )];
    const result = await judgeOpenSlotSupport({
      query: 'Who retains the customer relationship?',
      gaps,
      findings,
      brief: {
        queryShape: 'judgment',
        consequentialClaims: ['Retailers retain their customer relationships.'],
      },
      llm: {
        async complete({ messages }) {
          assert.match(messages[0].content, /slotMode=research_judgment/);
          assert.match(messages[1].content, /slotMode: research_judgment/);
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'supported',
              quote: 'Go live before code freeze to capture this year’s traffic. Your relationships stay yours.',
            }],
          });
        },
      },
    });
    applySlotSupportJudgments(gaps, result.judgments);
    assert.equal(gaps[0].slotSupport.quoteAnchored, true);
    assert.equal(gaps[0].slotSupport.verdict, 'supported');

    applySlotSupportJudgments(gaps, [{
      ...failClosedSupport('temporary_judge_failure'),
      gapId: 'gap-2',
    }]);
    assert.equal(gaps[0].slotSupport.quoteAnchored, true);
    assert.equal(gaps[0].slotSupport.verdict, 'supported');
  });

  it('reopens a verified anchored judgment after a later official body arrives', async () => {
    const gaps = [slotGap('gap-2', 'judgment_on_commerce_agents_design')];
    gaps[0].preferredHosts = ['anthropic.com'];
    const secondary = finding(
      'gap-2',
      'https://www.aicodex.to/articles/claude-commerce-agents',
      'The blueprint is deliberately portable across the deployment surfaces: Claude API Amazon Bedrock Microsoft Foundry Google Cloud Vertex AI. Product prices stay with the merchant.',
    );
    let calls = 0;
    const llm = {
      async complete({ messages }) {
        calls += 1;
        const text = JSON.stringify(messages);
        if (text.includes('claude.com/solutions')) {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'partially_supported',
              quote: 'Claude is the intelligence layer, not the storefront or the checkout.',
            }],
          });
        }
        return JSON.stringify({
          judgments: [{
            gapId: 'gap-2',
            verdict: 'supported',
            quote: 'The blueprint is deliberately portable across the deployment surfaces',
          }],
        });
      },
    };
    const first = await judgeOpenSlotSupport({
      query: 'Who keeps the shelf?',
      gaps,
      findings: [secondary],
      llm,
    });
    applySlotSupportJudgments(gaps, first.judgments);
    const evaluated = evaluateGapEvidence(gaps[0], secondary.sources, { slotSupport: gaps[0].slotSupport });
    Object.assign(gaps[0], evaluated);
    assert.equal(gaps[0].status, 'verified');
    assert.equal(gaps[0].slotSupport.verdict, 'supported');
    assert.equal(calls, 1);
    assert.equal(slotsNeedingSupport(gaps, { findings: [secondary] }).length, 0);

    const official = {
      gapId: 'gap-2',
      sources: [{
        id: 'https://claude.com/solutions/commerce',
        url: 'https://claude.com/solutions/commerce',
        content: 'Claude is the intelligence layer, not the storefront or the checkout. Merchants keep catalog and customer relationships.',
        fetchStatus: 'ok',
        assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
      }],
    };
    assert.equal(slotsNeedingSupport(gaps, { findings: [secondary, official] }).length, 1);
    const second = await judgeOpenSlotSupport({
      query: 'Who keeps the shelf?',
      gaps,
      findings: [secondary, official],
      llm,
    });
    assert.equal(second.cacheMisses, 1);
    assert.equal(calls, 2);
    applySlotSupportJudgments(gaps, second.judgments);
    assert.equal(gaps[0].slotSupport.verdict, 'partially_supported');
    assert.ok(gaps[0].slotSupport.officialSourceIds.includes('https://claude.com/solutions/commerce'));
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
    assert.equal(ownership.evidenceStatus || ownership.status, 'body_read');
    assert.equal(ownership.blockedReason, 'repair_exhausted');
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

function firstPartyFinding(gapId, url, content, extra = {}) {
  return {
    gapId,
    sources: [{
      id: url,
      url,
      content,
      fetchStatus: 'ok',
      assessment: extra.assessment || { firstParty: extra.firstParty === true, publisherType: extra.publisherType || 'unknown', contentKind: extra.contentKind || 'article' },
    }],
  };
}

describe('criterion-aware slot passage selection', () => {
  const question = 'Anthropic 开源 Commerce Agents 是在帮零售商把货架留在自己家里，还是在用可 fork 的正确做法把货架标准写成 Claude 的?';
  const reprint = '店面会话正在变成新的货架。Anthropic 开源 Commerce Agents，零售商可以把货架留在自己家里，可 fork 的正确做法把货架标准写成 Claude 的。'.repeat(2);
  const official = 'Anthropic published Commerce Agents as an open-source blueprint. Retailers can fork the reference implementation and keep checkout on their own site.';

  it('reserves a first_party official passage in topK over higher-overlap reprints', () => {
    const gap = {
      id: 'gap-2',
      question,
      requiredSlot: true,
      evidenceCriteria: ['first_party'],
    };
    const findings = [
      firstPartyFinding('gap-2', 'https://explainx.ai/a', reprint),
      firstPartyFinding('gap-2', 'https://theroberthu.com/a', reprint),
      firstPartyFinding('gap-2', 'https://juliangoldie.com/a', reprint),
      firstPartyFinding('gap-2', 'https://reprint.test/a', reprint),
      firstPartyFinding('gap-2', 'https://mirror.test/a', reprint),
      firstPartyFinding('gap-2', 'https://www.claude.com/blog/commerce', official, { firstParty: true, publisherType: 'official' }),
    ];
    const selected = selectSlotPassages(gap, findings, { topK: 3 });
    assert.ok(selected.some((item) => item.sourceId === 'https://www.claude.com/blog/commerce'));
    assert.equal(selected[0].assessment.firstParty, true);
  });

  it('cache-misses and rejudges after a first-party body arrives', async () => {
    const gap = {
      id: 'gap-2',
      question,
      requiredSlot: true,
      status: 'body_read',
      evidenceCriteria: ['first_party'],
    };
    const reprints = [
      firstPartyFinding('gap-2', 'https://explainx.ai/a', reprint),
      firstPartyFinding('gap-2', 'https://theroberthu.com/a', reprint),
      firstPartyFinding('gap-2', 'https://juliangoldie.com/a', reprint),
    ];
    const cache = new Map();
    let calls = 0;
    const llm = {
      async complete({ messages }) {
        calls += 1;
        const text = JSON.stringify(messages);
        if (text.includes('claude.com')) {
          return JSON.stringify({
            judgments: [{
              gapId: 'gap-2',
              verdict: 'supported',
              quote: 'Retailers can fork the reference implementation',
            }],
          });
        }
        return JSON.stringify({
          judgments: [{
            gapId: 'gap-2',
            verdict: 'unsupported',
            quote: '店面会话正在变成新的货架',
          }],
        });
      },
    };
    const first = await judgeOpenSlotSupport({
      query: question,
      gaps: [gap],
      findings: reprints,
      llm,
      cache,
    });
    applySlotSupportJudgments([gap], first.judgments);
    const firstEval = evaluateGapEvidence(gap, reprints.flatMap((item) => item.sources), { slotSupport: gap.slotSupport });
    assert.equal(firstEval.status, 'limited');
    assert.ok(firstEval.missingEvidence.includes('criterion:first_party'));
    assert.equal(first.cacheMisses, 1);

    const withOfficial = [
      ...reprints,
      firstPartyFinding('gap-2', 'https://www.claude.com/blog/commerce', official, { firstParty: true, publisherType: 'official' }),
    ];
    const second = await judgeOpenSlotSupport({
      query: question,
      gaps: [gap],
      findings: withOfficial,
      llm,
      cache,
    });
    assert.equal(second.cacheMisses, 1);
    assert.equal(second.cacheHits, 0);
    assert.ok(second.selections[0].selectedSourceIds.includes('https://www.claude.com/blog/commerce'));
    applySlotSupportJudgments([gap], second.judgments);
    const secondEval = evaluateGapEvidence(gap, withOfficial.flatMap((item) => item.sources), { slotSupport: gap.slotSupport });
    assert.equal(secondEval.status, 'verified');
    assert.equal(calls, 2);
  });

  it('changes the fingerprint when firstParty assessment flips to true', () => {
    const gap = {
      id: 'gap-2',
      question,
      requiredSlot: true,
      evidenceCriteria: ['first_party'],
    };
    const before = firstPartyFinding('gap-2', 'https://www.claude.com/blog/commerce', official, { firstParty: false });
    const after = firstPartyFinding('gap-2', 'https://www.claude.com/blog/commerce', official, { firstParty: true });
    assert.notEqual(
      slotSupportFingerprint(gap, selectSlotPassages(gap, [before]), {
        criterionPool: { first_party: [] },
      }),
      slotSupportFingerprint(gap, selectSlotPassages(gap, [after]), {
        criterionPool: { first_party: ['https://www.claude.com/blog/commerce'] },
      }),
    );
  });

  it('keeps an official but semantically unrelated body at body_read', async () => {
    const gap = slotGap('gap-2', 'SubjectA');
    gap.evidenceCriteria = ['first_party'];
    const findings = [firstPartyFinding('gap-2', 'https://docs.example.com/weather', UNRELATED_BODY, { firstParty: true })];
    const result = await judgeOpenSlotSupport({
      query: 'What is SubjectA official status?',
      gaps: [gap],
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
    applySlotSupportJudgments([gap], result.judgments);
    const evaluated = evaluateGapEvidence(gap, findings[0].sources, { slotSupport: gap.slotSupport });
    assert.equal(evaluated.status, 'body_read');
    assert.ok(evaluated.missingEvidence.includes('slot_support'));
    assert.equal(evaluated.missingEvidence.includes('criterion:first_party'), false);
  });

  it('requires a citable number for numeric criteria', () => {
    const gap = { id: 'gap-n', requiredSlot: true, evidenceCriteria: ['numeric'], question: 'revenue' };
    const withNumber = firstPartyFinding('gap-n', 'https://a.test/n', 'Revenue reached $12,400,000 in 2026.');
    const withoutNumber = firstPartyFinding('gap-n', 'https://a.test/w', 'The company discussed growth qualitatively.');
    const selected = selectSlotPassages(gap, [withoutNumber, withNumber], { topK: 1 });
    assert.equal(selected[0].sourceId, 'https://a.test/n');
    const missing = evaluateGapEvidence(gap, withoutNumber.sources);
    assert.ok(missing.missingEvidence.includes('criterion:numeric'));
  });

  it('requires filing provenance for filing criteria', () => {
    const gap = { id: 'gap-f', requiredSlot: true, evidenceCriteria: ['filing'], question: 'ownership' };
    const filing = firstPartyFinding('gap-f', 'https://hkex.test/a', 'This prospectus lists shareholders.', { contentKind: 'filing', publisherType: 'exchange_filing' });
    const blog = firstPartyFinding('gap-f', 'https://blog.test/a', 'A recap of the listing.');
    const selected = selectSlotPassages(gap, [blog, filing], { topK: 1 });
    assert.equal(selected[0].sourceId, 'https://hkex.test/a');
    assert.ok(evaluateGapEvidence(gap, blog.sources).missingEvidence.includes('criterion:filing'));
  });

  it('requires mainstream_media publisherType', () => {
    const gap = { id: 'gap-m', requiredSlot: true, evidenceCriteria: ['mainstream_media'], question: 'coverage' };
    const media = firstPartyFinding('gap-m', 'https://reuters.test/a', 'Mainstream coverage of the launch.', { publisherType: 'mainstream_media' });
    const ugc = firstPartyFinding('gap-m', 'https://forum.test/a', 'User discussion of the launch.', { publisherType: 'ugc' });
    const selected = selectSlotPassages(gap, [ugc, media], { topK: 1 });
    assert.equal(selected[0].sourceId, 'https://reuters.test/a');
    assert.ok(evaluateGapEvidence(gap, ugc.sources).missingEvidence.includes('criterion:mainstream_media'));
  });

  it('requires a user-named host for user_named criteria', () => {
    const gap = { id: 'gap-u', requiredSlot: true, evidenceCriteria: ['user_named'], question: 'official site' };
    const brief = { requiredHosts: ['claude.com'] };
    const named = firstPartyFinding('gap-u', 'https://www.claude.com/solutions/commerce', official, { publisherType: 'official' });
    const other = firstPartyFinding('gap-u', 'https://news.test/a', official);
    const selected = selectSlotPassages(gap, [other, named], { topK: 1, brief, query: 'see claude.com' });
    assert.equal(selected[0].sourceId, 'https://www.claude.com/solutions/commerce');
    assert.ok(evaluateGapEvidence(gap, other.sources, { brief, query: 'see claude.com' }).missingEvidence.includes('criterion:user_named'));
  });
});
