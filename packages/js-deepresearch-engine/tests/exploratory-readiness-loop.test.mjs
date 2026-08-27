import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { hasEmptyBullets } from '../src/research/report-builder.mjs';

function report() {
  return '# Research Report\n\n## Summary\n\nThe selected source provides enough evidence to answer the requested topic while keeping the agent source choice visible. [1.1]\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]';
}

function llmFor(decisions, { onEvaluation = () => JSON.stringify({ pass: true, missingAspect: '' }) } = {}) {
  return {
    async complete({ purpose }) {
      if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
      if (purpose === 'answer_evaluation') return onEvaluation();
      if (purpose === 'gap_decomposition') return 'no json here';
      if (purpose === 'research_profile') return '{}';
      return report();
    },
  };
}

describe('exploratory readiness loop', () => {
  it('cannot finalize immediately after search with no successful body', async () => {
    const decisions = [
      { action: 'search', query: 'no body topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'finalize', reasonCode: 'evidence_sufficient' },
      { action: 'read', sourceIds: ['https://nobody.test'], gapId: 'gap-1', reasonCode: 'forced_read' },
      { action: 'finalize', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'no body topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'Snippet', url: 'https://nobody.test', snippet: 'only a snippet' }];
      } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'answer_after_search'));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
  });

  it('does not advance a gap to body_read or verified on a WAF page', async () => {
    const { registerContentFetchHandler, resetContentFetchHandlers } = await import('../src/research/content-resolver.mjs');
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: 'Just a moment',
      content: 'Just a moment... Checking your browser before accessing the site. Cloudflare Ray ID: abc',
      backend: 'test',
    }));
    try {
      const result = await new ResearchRunner().run({
        query: 'What is Ollama?',
        settings: { llm: {}, search: {}, research: {
          strategy: 'exploratory',
          exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 1 },
          focused: { fetchMode: 'full', fetchBackend: 'auto' },
        } },
        search: { async search() {
          return [{ title: 'Docs', url: 'https://ollama.com/waf', snippet: 'docs' }];
        } },
        llm: llmFor([{ action: 'search', query: 'What is Ollama?', gapId: 'gap-1' }]),
      });
      const gap = result.gaps.find((item) => item.id === 'gap-1');
      assert.ok(gap);
      assert.notEqual(gap.status, 'body_read');
      assert.notEqual(gap.status, 'verified');
      assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
      assert.ok((result.findings[0].sources || []).some((source) => source.fetchStatus === 'waf' || source.bodyQuality === 'waf'));
    } finally {
      resetContentFetchHandlers();
    }
  });

  it('cannot emit evidence_sufficient while a required critical gap is still open', async () => {
    const result = await new ResearchRunner().run({
      query: 'Investment due diligence using hkexnews.hk filings for controlling shareholder and audited revenue',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 1, profilePlanner: false },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{
          title: 'Media reprint',
          url: 'https://media.example/zhipu',
          content: 'A newspaper says the company is growing quickly and may list soon.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: 'company overview', gapId: 'gap-1' },
        { action: 'finalize', reasonCode: 'evidence_sufficient' },
      ]),
    });
    const root = result.gaps.find((gap) => gap.id === 'gap-1');
    assert.ok(['open', 'searched', 'body_read', 'missing', 'blocked'].includes(root.status));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
  });

  it('continues or stops with source_blocked instead of evidence_sufficient when the required host is missing', async () => {
    const searched = [];
    const result = await new ResearchRunner().run({
      query: 'Read the issuer annual report on hkexnews.hk for audited revenue',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 1, profilePlanner: false },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(query) {
        searched.push(query);
        return [{
          title: 'Media',
          url: 'https://finance.example/reprint',
          content: 'Secondary coverage of revenue without the filing.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: 'issuer revenue', gapId: 'gap-1' },
        { action: 'finalize', reasonCode: 'evidence_sufficient' },
      ]),
    });
    assert.ok(searched.some((query) => /site:hkexnews\.hk/i.test(query)));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(['source_blocked', 'budget_exhausted', 'safety_cap'].includes(result.quality.stopReason));
  });

  it('stops with budget_exhausted and lists unresolved gaps in the report', async () => {
    const result = await new ResearchRunner().run({
      query: 'Investment due diligence using hkexnews.hk filings',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0, maxSearchRequests: 1, profilePlanner: false },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'Media', url: 'https://media.example/page', snippet: 'reprint only' }];
      } },
      llm: llmFor([{ action: 'search', query: 'filings', gapId: 'gap-1' }]),
    });
    assert.equal(result.quality.stopReason, 'budget_exhausted');
    assert.match(result.report, /Unresolved gaps/i);
  });

  it('reranks unread candidates with the current gap question, not the first batched query', async () => {
    const rerankQueries = [];
    const decisions = [
      { action: 'search', queries: ['first batched query', 'second batched query'], gapId: 'gap-2', reasonCode: 'multi' },
      { action: 'read', sourceIds: ['https://gap-focus.test'], gapId: 'gap-2', reasonCode: 'read' },
      { action: 'finalize', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'compare alpha and beta',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0, maxQueriesPerStep: 3, profilePlanner: false },
        focused: { fetchMode: 'disabled' },
        providers: {
          rerank: {
            provider: 'rules',
            async rerank({ query, documents }) {
              rerankQueries.push(query);
              return {
                items: documents.map((document, originalIndex) => ({ id: document.id, originalIndex, score: 0.5 })),
                provider: 'test-rerank',
                model: 'test-rerank',
                usage: { requests: 1, tokens: 0 },
                durationMs: 1,
                degraded: false,
              };
            },
          },
        },
      } },
      search: { async search() {
        return [{ title: 'A', url: 'https://gap-focus.test', content: 'Alpha evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions, {
        onEvaluation: () => JSON.stringify({ pass: false, missingAspect: '' }),
      }),
    });
    const tracedQueries = result.trace
      .filter((entry) => entry.action === 'rerank' && entry.query)
      .map((entry) => entry.query);
    const observed = rerankQueries.length ? rerankQueries : tracedQueries;
    assert.ok(observed.length, 'rerank should run after search against unread candidates');
    assert.ok(observed.every((query) => query !== 'first batched query'));
    assert.ok(observed.some((query) => /alpha|beta|compare/i.test(query)));
  });

  it('rejects a paraphrased duplicate search without consuming another search request', async () => {
    const decisions = [
      { action: 'search', query: 'open topic space', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://para.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'search', query: 'What is an open topic space?', gapId: 'gap-1', reasonCode: 'paraphrase' },
      { action: 'finalize', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'open topic space',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'P', url: 'https://para.test', content: 'Open topic space evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && (entry.reasonCode === 'duplicate_query' || entry.reasonCode === 'repeat_action')));
    assert.equal(result.quality.budget.usage.searchRequests, 1);
  });

  it('rejects empty bullets in report validation', () => {
    assert.equal(hasEmptyBullets('- \n- real finding [1.1]'), true);
    assert.equal(hasEmptyBullets('- The selected source provides evidence [1.1]'), false);
  });
});

describe('exploratory state machine helpers', () => {
  it('rejects finalize after search until a successful body is read in that cycle', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 6 });
    state.addCandidates([{ url: 'https://a.test', title: 'A' }], 'gap-1');
    state.lastAction = 'search';
    state.recordSearchCycle({ gapId: 'gap-1', newUrls: 1 });
    assert.equal(state.validate({ action: 'finalize', reasonCode: 'evidence_sufficient' }), 'answer_after_search');
    assert.equal(state.validate({ action: 'draft' }), 'answer_after_search');
    state.recordSuccessfulBodies(1);
    assert.equal(state.validate({ action: 'finalize' }), null);
  });
});
