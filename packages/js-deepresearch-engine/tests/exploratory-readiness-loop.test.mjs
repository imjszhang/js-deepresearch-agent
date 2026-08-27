import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { emptyBulletLines } from '../src/research/report-builder.mjs';

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

  it('stops with source_blocked instead of evidence_sufficient when a required host is missing', async () => {
    const decisions = [
      { action: 'search', query: '智谱 招股书', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://finance.sina.com.cn/zhipu'], gapId: 'gap-1', reasonCode: 'read_media' },
      { action: 'answer', reasonCode: 'evidence_sufficient' },
    ];
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
      llm: llmFor(decisions),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(['source_blocked', 'safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.ok((result.quality.limitations || []).some((line) => /unresolved|required|hkex|host/i.test(line)));
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
