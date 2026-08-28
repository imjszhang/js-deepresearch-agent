import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { inferResearchProfile } from '../src/research/adaptive/research-profile.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { emptyBulletLines } from '../src/research/report-builder.mjs';
import { extractPublishedDate, sourceHasObservableDate } from '../src/research/body-quality.mjs';
import {
  buildSiteHostQueries,
  nextUnusedSiteQueries,
  shortSearchTerms,
} from '../src/research/adaptive/source-policy.mjs';

function report() {
  return '# Research Report\n\n## Summary\n\nThe selected source provides enough evidence to answer the requested topic while keeping the agent source choice visible. [1.1]\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]';
}

function llmFor(decisions, { onEvaluation = () => report(), onDecompose = () => 'no json here' } = {}) {
  return {
    async complete({ purpose }) {
      if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
      if (purpose === 'answer_evaluation') return onEvaluation();
      if (purpose === 'gap_decomposition') return onDecompose();
      if (purpose === 'research_profile') return '{}';
      return report();
    },
  };
}

describe('exploratory Search-Read-Reason loop', () => {
  it('cannot finalize immediately after search with no successful body', async () => {
    const state = new ResearchState({ query: 'open topic space', maxSteps: 8 });
    state.addCandidates([{ url: 'https://a.test', title: 'A' }], 'gap-1');
    state.beginSearchCycle();
    state.lastAction = 'search';
    assert.equal(state.validate({ action: 'finalize' }), 'answer_after_search');
    assert.equal(state.validate({ action: 'draft' }), 'answer_after_search');
    assert.equal(state.validate({ action: 'answer' }), 'answer_after_search');

    const decisions = [
      { action: 'search', query: 'no body yet', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'answer', reasonCode: 'too_soon' },
      { action: 'read', sourceIds: ['https://nobody.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'no body yet',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 1, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'Empty', url: 'https://nobody.test', snippet: 'only a snippet' }];
      } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => (
      entry.status === 'rejected' && entry.reasonCode === 'answer_after_search'
    ) || (entry.action === 'evaluate_report' && entry.reasonCode === 'missing_direct_evidence')));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
  });

  it('does not advance a gap after a WAF or shell page', async () => {
    const decisions = [
      { action: 'search', query: 'waf topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://waf.test'], gapId: 'gap-1', reasonCode: 'read_waf' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'waf topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{
          title: 'Blocked',
          url: 'https://waf.test',
          content: 'Just a moment... Cloudflare',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor(decisions),
    });
    const gap = result.gaps.find((item) => item.id === 'gap-1');
    assert.ok(gap);
    assert.ok(!['body_read', 'verified'].includes(gap.status));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
  });

  it('keeps searching after a reprint when the gate fails and token budget remains', async () => {
    const query = '智谱 港交所 招股书 营收 控股股东';
    const state = new ResearchState({ query, minLlmTokens: 0 });
    state.addCandidates([{ url: 'https://finance.sina.com.cn/zhipu', title: 'Media' }], 'gap-1');
    state.readSourceIds.add('https://finance.sina.com.cn/zhipu');
    state.findings.push({
      gapId: 'gap-1',
      sources: [{
        title: 'Media',
        url: 'https://finance.sina.com.cn/zhipu',
        content: 'A media reprint of listing rumors and revenue estimates with enough body text.',
        fetchStatus: 'ok',
      }],
    });
    state.observations.push({ type: 'search_result', query, resultCount: 1 });
    state.lastAction = 'read';
    state.refreshBudgetView({
      budget: {
        usage: { llmTokens: 800 },
        limits: { llmTokens: 200000 },
        updateReportReserve() { return 0; },
      },
      minLlmTokens: 0,
    });
    assert.equal(state.readiness.pass, false);
    const action = fallbackAdaptiveAction(state, {
      belowMin: false,
      belowHardCap: true,
      readiness: state.readiness,
    });
    assert.equal(action.action, 'search');
    assert.notEqual(action.action, 'finalize');
    assert.notEqual(action.reasonCode, 'fallback_source_blocked');
    assert.ok([action.query, ...(action.queries || [])].some((item) => /site:/i.test(item)));

    const searches = [];
    const result = await new ResearchRunner().run({
      query,
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 200000, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        return [{
          title: 'Media',
          url: 'https://finance.sina.com.cn/zhipu',
          content: 'A media reprint of listing rumors and revenue estimates with enough body text.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: '智谱 招股书', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'read', sourceIds: ['https://finance.sina.com.cn/zhipu'], gapId: 'gap-1', reasonCode: 'read_media' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
      ]),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.notEqual(result.quality.stopReason, 'source_blocked');
    assert.ok(['safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.ok(searches.length >= 2);
    assert.ok(searches.some((item) => /site:hkexnews\.hk/i.test(item)));
    assert.ok((result.quality.limitations || []).some((line) => /unresolved|required|hkex|host/i.test(line)));
  });

  it('keeps changing site terms when official hosts only return WAF pages', async () => {
    const searches = [];
    const result = await new ResearchRunner().run({
      query: '智谱 港交所 招股书 营收 控股股东',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 200000, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        return [{
          title: 'HKEX',
          url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/zhipu.htm',
          content: 'Just a moment... Cloudflare',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: '智谱 招股书', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'read', sourceIds: ['https://www1.hkexnews.hk/listedco/listconews/sehk/2026/zhipu.htm'], gapId: 'gap-1', reasonCode: 'read_waf' },
        { action: 'answer', reasonCode: 'done' },
        { action: 'answer', reasonCode: 'done' },
        { action: 'answer', reasonCode: 'done' },
      ]),
    });
    const gap = result.gaps.find((item) => item.id === 'gap-1');
    assert.ok(gap);
    assert.notEqual(gap.status, 'blocked');
    assert.notEqual(gap.blockedReason, 'required_host_unreadable');
    assert.notEqual(result.quality.stopReason, 'source_blocked');
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(['safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.ok(searches.length >= 2);
    assert.ok(new Set(searches.filter((item) => /site:/i.test(item))).size >= 2);
  });

  it('cannot emit evidence_sufficient without a required host and stops with budget or safety', async () => {
    const result = await new ResearchRunner().run({
      query: '智谱 港交所 招股书 营收 控股股东',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{
          title: 'Media',
          url: 'https://finance.sina.com.cn/zhipu',
          content: 'A media reprint of listing rumors and revenue estimates with enough body text.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: '智谱 招股书', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'read', sourceIds: ['https://finance.sina.com.cn/zhipu'], gapId: 'gap-1', reasonCode: 'read_media' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
      ]),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(['safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.notEqual(result.quality.stopReason, 'source_blocked');
    assert.ok((result.quality.limitations || []).some((line) => /unresolved|required|hkex|host/i.test(line)));
  });

  it('does not verify a primary_filing gap from reprints or a mismatched official PDF', () => {
    const reprintState = new ResearchState({ query: '智谱 监管披露 年报 投资' });
    assert.ok((reprintState.profile.requiredSourceTypes || []).includes('primary_filing'));
    assert.equal((reprintState.profile.requiredHosts || []).length, 0);
    assert.ok(reprintState.profile.preferredHosts.includes('hkexnews.hk'));
    reprintState.findings.push({
      gapId: 'gap-1',
      sources: [{
        title: 'Media reprint',
        url: 'https://finance.sina.com.cn/zhipu',
        content: 'A media reprint of 智谱 revenue rumors with enough body text for a successful read.',
        fetchStatus: 'ok',
      }],
    });
    reprintState.syncGapCoverage();
    assert.notEqual(reprintState.gaps[0].status, 'verified');
    assert.equal(reprintState.gapHasRequiredHostBody('gap-1'), false);

    const mismatch = new ResearchState({ query: '智谱 监管披露 年报 投资' });
    mismatch.findings.push({
      gapId: 'gap-1',
      sources: [{
        title: '思朗科技 002239 2025年年度报告',
        url: 'https://static.sse.com.cn/disclosure/listedinfo/announcement/c/2025-04-01/002239.pdf',
        content: '思朗科技股份有限公司2025年年度报告正文，包含收入与股东信息。'.repeat(3),
        fetchStatus: 'ok',
      }],
    });
    mismatch.syncGapCoverage();
    assert.equal(mismatch.gaps[0].status, 'body_read');
    assert.equal(mismatch.gapHasRequiredHostBody('gap-1'), false);
  });

  it('uses body dates for freshness and short site terms for preferred hosts', () => {
    assert.equal(extractPublishedDate('智谱更新 2026-03-31 披露'), '2026-03-31');
    assert.equal(sourceHasObservableDate({
      title: '智谱 2026-03-31 更新',
      content: 'Published 2026-03-31 with enough official disclosure text.',
    }), true);
    const query = '截至 2026-08 智谱 最新 监管披露';
    const profile = inferResearchProfile(query);
    assert.equal(profile.flags.freshness, true);
    const gate = evaluateReadinessGate({
      query,
      profile,
      gaps: [{
        id: 'gap-1',
        question: query,
        status: 'verified',
        priority: 'critical',
        requiredHosts: [],
        requiredSourceTypes: ['primary_filing'],
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [{
          title: '智谱 2026-03-31 更新',
          url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/zhipu.htm',
          content: 'Published 2026-03-31. 智谱披露股权与收入，正文足够长用于判定成功读取。',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.ok(!gate.failures.some((failure) => failure.code === 'freshness_unknown'));

    const gap = {
      question: 'controlling shareholder and audited revenue for a long unmatched gap sentence',
      requiredHosts: ['hkexnews.hk'],
      preferredHosts: ['sse.com.cn'],
    };
    const short = shortSearchTerms('智谱AI（Zhipu AI）截至 2026-08 的股权结构与监管披露');
    assert.ok(short.length <= 24);
    assert.ok(!/股权结构与监管披露/.test(short));
    assert.ok(buildSiteHostQueries(gap, short).every((item) => !item.includes(gap.question)));
    const unused = nextUnusedSiteQueries(gap, '智谱 02513', ['site:hkexnews.hk 智谱 02513']);
    assert.ok(unused.length);
    assert.ok(!unused.includes('site:hkexnews.hk 智谱 02513'));
  });

  it('records budget_exhausted and lists unresolved gaps', async () => {
    const decisions = [
      { action: 'search', query: 'budget gap topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'search', query: 'should not run', gapId: 'gap-1', reasonCode: 'should_not_run' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget gap topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, maxSearchRequests: 1, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'Only', url: 'https://budget-gap.test', snippet: 'gathered evidence' }];
      } },
      llm: llmFor(decisions),
    });
    assert.equal(result.quality.stopReason, 'budget_exhausted');
    assert.ok((result.quality.limitations || []).some((line) => /Unresolved gaps/i.test(line)));
    assert.ok(!result.trace.some((entry) => entry.reasonCode === 'should_not_run'));
  });

  it('reranks unread candidates with the current gap question', async () => {
    const rerankQueries = [];
    const decisions = [
      { action: 'search', query: 'batched first query', gapId: 'gap-3', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://gap-two.test'], gapId: 'gap-3', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'compare alpha and beta systems',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
        providers: {
          embedding: { provider: 'disabled' },
          rerank: {
            provider: 'rules',
            async rerank({ query, documents }) {
              rerankQueries.push(query);
              return {
                provider: 'test-rerank',
                model: 'test-rerank',
                items: documents.map((document, index) => ({ id: document.id, score: 1 - index * 0.1 })),
                durationMs: 1,
              };
            },
          },
        },
      } },
      search: { async search() {
        return [{
          title: 'Beta',
          url: 'https://gap-two.test',
          content: 'How does beta work? Official body evidence for the second subject.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor(decisions, {
        onDecompose: () => JSON.stringify({ subQuestions: ['How does alpha work?', 'How does beta work?'] }),
      }),
    });
    assert.ok(rerankQueries.length);
    assert.ok(rerankQueries.every((query) => query !== 'batched first query'));
    assert.ok(rerankQueries.some((query) => /beta/i.test(query)));
    assert.ok(result.trace.some((entry) => entry.action === 'rerank' && /beta/i.test(entry.query || '')));
  });

  it('rejects a paraphrased duplicate search query', async () => {
    const decisions = [
      { action: 'search', query: 'duplicate paraphrase topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://para.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'search', query: 'What is a duplicate paraphrase topic?', gapId: 'gap-1', reasonCode: 'search_paraphrase' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'duplicate paraphrase topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{
          title: 'P',
          url: 'https://para.test',
          content: 'Duplicate paraphrase topic evidence from a selected source.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'duplicate_query'));
    assert.equal(result.quality.budget.usage.searchRequests, 1);
  });

  it('rejects empty bullets during report validation', () => {
    const check = emptyBulletLines('# Research Report\n\n## Key Findings\n-\n- Real finding [1.1]\n');
    assert.equal(check.length, 1);
  });
});
