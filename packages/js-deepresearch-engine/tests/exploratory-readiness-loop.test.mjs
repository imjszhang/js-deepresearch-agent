import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner, SearchProviderError } from '../src/index.mjs';
import { fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { inferResearchProfile } from '../src/research/adaptive/research-profile.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { emptyBulletLines } from '../src/research/report-builder.mjs';
import { extractPublishedDate, sourceHasObservableDate } from '../src/research/body-quality.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';
import { allowedSiteHosts, validatePlannedQuery } from '../src/research/search-query-planner.mjs';

function report() {
  return '# Research Report\n\n## Summary\n\nThe selected source provides enough evidence to answer the requested topic while keeping the agent source choice visible. [1.1]\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]';
}

const HKEX_PROFILE = {
  flags: { primary_source: true, numeric: true, decision_critical: true },
  requiredHosts: ['hkexnews.hk'],
  preferredHosts: [],
  requiredSourceTypes: ['primary_filing'],
  minIndependentSources: 2,
};

function llmFor(decisions, {
  onEvaluation = () => report(),
  onDecompose = () => 'no json here',
  onProfile = () => JSON.stringify({
    requiredAnswerSlots: [{ answerSlot: 'topic', question: 'topic evidence', priority: 'normal' }],
    minIndependentSources: 1,
  }),
  onGapSupport = null,
} = {}) {
  return {
    async complete({ purpose, messages }) {
      if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
      if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
      if (purpose === 'answer_evaluation') return onEvaluation();
      if (purpose === 'gap_decomposition') return onDecompose();
      if (purpose === 'research_profile') return onProfile();
      if (purpose === 'source_assessment') {
        return JSON.stringify({
          summary: 'Selected source provides enough evidence for the requested topic.',
          readability: 'readable',
          contentKind: 'article',
          publisherType: 'official',
          firstParty: true,
          evidenceTier: 'other_primary',
          reason: 'test assessment',
        });
      }
      if (purpose === 'gap_support') {
        if (onGapSupport) return onGapSupport({ messages });
        const text = (messages || []).map((item) => item.content).join('\n');
        const quote = (text.match(/\] ([^\n]+)/) || [])[1] || '';
        const gapIds = [...new Set([...text.matchAll(/gapId:\s+(gap-\S+)/g)].map((match) => match[1]))];
        return JSON.stringify({
          judgments: (gapIds.length ? gapIds : ['gap-2']).map((gapId) => ({
            gapId,
            verdict: quote.length >= 12 ? 'supported' : 'unverifiable',
            quote,
            reason: 'test default support',
          })),
        });
      }
      return report();
    },
  };
}

function hkexProfileLlm(decisions, extras = {}) {
  return llmFor(decisions, {
    ...extras,
    onProfile: () => JSON.stringify(HKEX_PROFILE),
  });
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
    const state = new ResearchState({ query, minLlmTokens: 0, profile: HKEX_PROFILE });
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
    assert.equal(action.needsPlanner, true);
    assert.ok(!action.query);
    assert.notEqual(action.action, 'finalize');
    assert.notEqual(action.reasonCode, 'fallback_source_blocked');

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
      llm: hkexProfileLlm([
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
    assert.ok(!searches.some((item) => /site:hkexnews\.hk/i.test(item)));
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
      llm: hkexProfileLlm([
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
    assert.ok(!searches.some((item) => /primary source evidence/.test(item)));
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
      llm: hkexProfileLlm([
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
    const inferred = inferResearchProfile('智谱 监管披露 年报 投资');
    assert.ok(!(inferred.requiredSourceTypes || []).includes('primary_filing'));
    assert.equal((inferred.requiredHosts || []).length, 0);
    assert.ok(!inferred.preferredHosts.includes('hkexnews.hk'));
    const reprintState = new ResearchState({
      query: '智谱 监管披露 年报 投资',
      profile: {
        flags: { primary_source: true },
        requiredHosts: [],
        preferredHosts: [],
        requiredSourceTypes: ['primary_filing'],
        minIndependentSources: 1,
      },
    });
    assert.ok((reprintState.profile.requiredSourceTypes || []).includes('primary_filing'));
    assert.equal((reprintState.profile.requiredHosts || []).length, 0);
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

    const mismatch = new ResearchState({
      query: '智谱 监管披露 年报 投资',
      profile: reprintState.profile,
    });
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
    assert.equal(mismatch.gaps[0].status, 'limited');
    assert.ok(mismatch.gaps[0].missingEvidence.includes('primary_filing'));
    assert.equal(mismatch.gapHasRequiredHostBody('gap-1'), false);
  });

  it('uses body dates for freshness and short site terms for preferred hosts', () => {
    assert.equal(extractPublishedDate('智谱更新 2026-03-31 披露'), '2026-03-31');
    assert.equal(sourceHasObservableDate({
      title: '智谱 2026-03-31 更新',
      content: 'Published 2026-03-31 with enough official disclosure text.',
    }), true);
    const query = '截至 2026-08 智谱 最新 监管披露';
    const profile = {
      flags: { freshness: true },
      requiredHosts: [],
      preferredHosts: [],
      requiredSourceTypes: [],
      minIndependentSources: 1,
    };
    assert.equal(inferResearchProfile(query).flags.freshness, false);
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

    assert.deepEqual(allowedSiteHosts({
      gap: { requiredHosts: ['hkexnews.hk'], preferredHosts: ['sse.com.cn'] },
      siteQueryMode: 'confirmed',
      observedHosts: [],
    }), ['hkexnews.hk']);
    assert.equal(validatePlannedQuery('site:sse.com.cn 智谱 02513', {
      gap: { requiredHosts: ['hkexnews.hk'], preferredHosts: ['sse.com.cn'] },
      siteQueryMode: 'confirmed',
      observedHosts: [],
    }).reason, 'site_mode_violation');
  });

  it('can reach evidence_sufficient on official docs without inventing exchange hosts', async () => {
    const query = 'What is the official positioning of llama.cpp?';
    const inferred = inferResearchProfile(query);
    assert.deepEqual(inferred.requiredHosts, []);
    assert.deepEqual(inferred.preferredHosts, []);
    assert.ok(!inferred.requiredSourceTypes.includes('primary_filing'));
    const searches = [];
    const result = await new ResearchRunner().run({
      query,
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        return [{
          title: 'llama.cpp README',
          url: 'https://github.com/ggml-org/llama.cpp',
          content: 'llama.cpp is a C/C++ inference library. Official positioning and usage are documented in this repository README with enough body text.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: 'llama.cpp official positioning', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'read', sourceIds: ['https://github.com/ggml-org/llama.cpp'], gapId: 'gap-1', reasonCode: 'read' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
      ]),
    });
    assert.equal(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(!searches.some((item) => /hkexnews|sec\.gov|sse\.com\.cn|szse\.cn/i.test(item)));
    assert.ok(!(result.quality.limitations || []).some((line) => /hkexnews|sec\.gov|sse\.com\.cn|szse\.cn/i.test(line)));
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
        onProfile: () => JSON.stringify({
          requiredAnswerSlots: [
            { answerSlot: 'alpha', question: 'How does alpha work?' },
            { answerSlot: 'beta', question: 'How does beta work?' },
          ],
          minIndependentSources: 1,
        }),
      }),
    });
    assert.ok(rerankQueries.length);
    assert.ok(rerankQueries.every((query) => query !== 'batched first query'));
    assert.ok(rerankQueries.some((query) => /beta/i.test(query)));
    assert.ok(result.trace.some((entry) => entry.action === 'rerank' && /beta/i.test(entry.query || '')));
  });

  it('does not read an off-topic candidate below the external rerank threshold', async () => {
    const result = await new ResearchRunner().run({
      query: '智谱AI监管合规',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 5, maxEvaluationRetries: 0, autoReadTopK: 1 },
        focused: { fetchMode: 'disabled' },
        providers: {
          embedding: { provider: 'disabled' },
          rerank: {
            provider: 'http',
            async rerank({ documents }) {
              return {
                provider: 'http',
                model: 'jina-reranker-v3',
                items: documents.map((document) => ({
                  id: document.id,
                  score: document.id.includes('relevant') ? 0.45 : -0.12,
                })),
                durationMs: 1,
                usage: { requests: 1, tokens: 0 },
              };
            },
          },
        },
      } },
      search: { async search() {
        return [
          { id: 'irrelevant', title: 'Catholic manuscript list', url: 'https://guides.lib.cua.edu/list', content: 'Unrelated manuscripts and archives.', fetchStatus: 'ok' },
          { id: 'relevant', title: '智谱AI监管合规', url: 'https://example.com/zhipu', content: '智谱AI公开了监管合规与备案信息。', fetchStatus: 'ok' },
        ];
      } },
      llm: llmFor([
        { action: 'search', query: '智谱AI监管合规', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'answer', reasonCode: 'done' },
      ], {
        onProfile: () => JSON.stringify({
          entities: ['智谱AI', '智谱'],
          requiredAnswerSlots: [{ answerSlot: 'regulatory', question: '智谱AI监管合规' }],
          minIndependentSources: 1,
        }),
      }),
    });
    const readIds = result.trace
      .filter((entry) => entry.action === 'read')
      .flatMap((entry) => entry.sourceIds || []);
    assert.ok(readIds.includes('relevant'));
    assert.ok(!readIds.includes('irrelevant'));
    assert.equal(result.quality.metrics.relevance.returnedCandidates, 2);
    assert.equal(result.quality.metrics.relevance.rerankEvaluated, 2);
    assert.equal(result.quality.metrics.relevance.rerankRejected, 1);
    assert.equal(result.quality.metrics.relevance.readAccepted, 1);
    const rerankTrace = result.trace.find((entry) => (
      entry.action === 'rerank' && entry.selectedReason === 'current_gap_unread'
    ));
    assert.equal(rerankTrace.provider, 'http');
    assert.equal(rerankTrace.model, 'jina-reranker-v3');
    assert.equal(rerankTrace.threshold, 0.01);
    assert.equal(rerankTrace.acceptedCount + rerankTrace.rejectedCount, rerankTrace.inputCount);
    const relevant = result.sources.find((source) => source.url === 'https://example.com/zhipu');
    assert.ok(relevant.relevanceDecision.gapId);
    assert.deepEqual(
      relevant.relevanceDecision,
      relevant.relevanceDecisionByGap[relevant.relevanceDecision.gapId],
    );
  });

  it('does not reject an un-reranked match for another gap as below threshold', () => {
    const state = new ResearchState({
      query: '智谱AI公司与监管',
      settings: {
        research: {
          read: {
            relevance: {
              enabled: true,
              entityGuard: true,
              minRerankScore: 0.5,
            },
          },
        },
      },
      brief: { entities: ['智谱AI'] },
    });
    const second = state.addGap('智谱AI监管情况', 'normal', { id: 'gap-2', answerSlot: 'regulatory' });
    state.addCandidates([{
      id: 'shared',
      title: '智谱AI公司信息',
      url: 'https://example.com/zhipu',
      rerank: { provider: 'http', score: 0.9 },
    }], 'gap-1', { query: '智谱AI公司' });
    state.addCandidates([{
      id: 'shared',
      title: '智谱AI监管情况',
      url: 'https://example.com/zhipu',
      rerank: null,
    }], second.id, { query: '智谱AI监管' });
    const [picked] = state.pickPolicyReads(1, second.id);
    assert.equal(picked.relevanceDecision.accepted, true);
    assert.equal(picked.relevanceDecision.rerankScore, null);
    assert.equal(picked.relevanceDecision.reasonCode, 'rerank_not_evaluated');
  });

  it('records and excludes off-host results returned for a site query', async () => {
    const result = await new ResearchRunner().run({
      query: '智谱AI官方合规说明 zhipuai.cn',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 4, maxEvaluationRetries: 0, autoReadTopK: 1 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [
          { id: 'off-host', title: 'Microsoft Outlook', url: 'https://outlook.office.com/mail', snippet: 'email' },
          { id: 'on-host', title: '智谱AI合规', url: 'https://www.zhipuai.cn/compliance', content: '智谱AI官方合规备案信息。', fetchStatus: 'ok' },
        ];
      } },
      llm: llmFor([
        { action: 'search', query: 'site:zhipuai.cn 智谱AI 合规', gapId: 'gap-2', reasonCode: 'search' },
        { action: 'answer', reasonCode: 'done' },
      ], {
        onProfile: () => JSON.stringify({
          entities: ['智谱AI', '智谱'],
          requiredAnswerSlots: [{
            answerSlot: 'compliance',
            question: '智谱AI官方合规说明',
            requiredHosts: ['zhipuai.cn'],
          }],
          minIndependentSources: 1,
        }),
      }),
    });
    assert.equal(result.quality.metrics.relevance.returnedCandidates, 2);
    assert.equal(result.quality.metrics.relevance.siteRejected, 1);
    assert.equal(result.quality.metrics.relevance.admittedCandidates, 1);
    assert.ok(result.trace.some((entry) => (
      entry.action === 'search_filter'
      && entry.reasonCode === 'site_constraint_violation'
      && entry.rejectedCount === 1
    )));
    assert.ok(!result.sources.some((source) => source.id === 'off-host' || source.url?.includes('outlook.office.com')));
  });

  it('does not count a fully site-filtered query and falls back without site in the same step', async () => {
    const searches = [];
    const result = await new ResearchRunner().run({
      query: '智谱AI官方合规说明 zhipuai.cn',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 3, maxQueriesPerStep: 2, autoReadTopK: 1 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        if (/site:/.test(searchQuery)) {
          return [{ id: 'wrong-host', title: '智谱AI新闻', url: 'https://media.example/zhipu', snippet: '智谱AI合规' }];
        }
        return [{ id: 'official', title: '智谱AI合规', url: 'https://zhipuai.cn/compliance', content: '智谱AI官方合规备案信息。', fetchStatus: 'ok' }];
      } },
      llm: llmFor([
        { action: 'search', query: 'site:zhipuai.cn 智谱AI 合规', gapId: 'gap-2', reasonCode: 'search' },
        { action: 'answer', reasonCode: 'done' },
      ], {
        onProfile: () => JSON.stringify({
          entities: ['智谱AI'],
          requiredAnswerSlots: [{
            answerSlot: 'compliance',
            question: '智谱AI官方合规说明',
            requiredHosts: ['zhipuai.cn'],
          }],
        }),
      }),
    });
    assert.equal(searches.length >= 2, true);
    assert.match(searches[0], /site:zhipuai\.cn/);
    assert.doesNotMatch(searches[1], /site:/);
    const gap = result.gaps.find((item) => item.exhaustedAngles?.includes(searches[0]));
    assert.ok(!gap.searchedQueries.includes(searches[0]));
    assert.ok(gap.exhaustedAngles.includes(searches[0]));
    assert.ok(gap.searchedQueries.includes(searches[1]));
    assert.equal(result.quality.metrics.recovery.siteFilteredAllQueries, 1);
    assert.equal(result.quality.metrics.recovery.siteFallbackQueries, 1);
    assert.ok(result.trace.some((entry) => (
      entry.reasonCode === 'site_fallback_query'
      && entry.queryOrigin === 'llm_planner'
      && entry.siteFallbackOf === searches[0]
    )));
  });

  it('does not invent a rule query when the planner fails', async () => {
    const searches = [];
    const result = await new ResearchRunner().run({
      query: 'planner failure topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 0,
          maxLlmTokens: 0,
          maxSteps: 4,
          maxEvaluationRetries: 0,
          autoReadTopK: 0,
          maxRepairFailuresPerGap: 1,
          maxConsecutiveInvalidSteps: 2,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        return [];
      } },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
          if (purpose === 'agent_decision') {
            return JSON.stringify({ action: 'search', gapId: 'gap-1', plannerMode: 'repair' });
          }
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [{ answerSlot: 'topic', question: 'planner failure topic' }],
            });
          }
          return report();
        },
      },
    });
    assert.ok(searches.every((item) => item === 'planner failure topic'));
    assert.ok(!searches.some((item) => /primary source evidence|site:/.test(item)));
    assert.ok(['query_planner_exhausted', 'repair_exhausted', 'max_steps'].includes(result.quality.stopDetail) || result.quality.stopReason);
  });

  it('rejects a paraphrased duplicate search query', async () => {
    const decisions = [
      { action: 'search', query: 'duplicate paraphrase topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'search', query: 'duplicate paraphrase topic', gapId: 'gap-1', reasonCode: 'search_paraphrase' },
      { action: 'read', sourceIds: ['https://para.test'], gapId: 'gap-1', reasonCode: 'read' },
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
    assert.ok(result.trace.some((entry) => (
      (entry.status === 'rejected' && ['duplicate_query', 'missing_query', 'repeat_action'].includes(entry.reasonCode))
      || (entry.action === 'search_query_planned' && entry.failure)
      || (entry.action === 'read' && ['fallback_read_evidence', 'slot_repair_read'].includes(entry.reasonCode))
    )));
    assert.ok(result.quality.budget.usage.searchRequests >= 1);
  });

  it('recovers from duplicate queries by reading or stopping instead of numeric suffixes', async () => {
    const queries = [];
    const decisions = [
      { action: 'search', query: 'open topic space', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'search', query: 'open topic space', gapId: 'gap-1', reasonCode: 'repeat' },
    ];
    const result = await new ResearchRunner().run({
      query: 'open topic space',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
          focused: { fetchMode: 'full' },
          budget: { maxSearchRequests: 4, maxSourceReads: 2, maxLlmTokens: 0 },
        },
      },
      search: {
        async search(query) {
          queries.push(query);
          return [{
            title: 'Body',
            url: 'https://topic.test/page',
            content: 'Open topic space evidence from a selected source with enough body text.',
            fetchStatus: 'ok',
          }];
        },
      },
      llm: llmFor(decisions),
    });
    assert.ok(queries.every((query) => !/\s+\d+(-\d+)?$/.test(query)));
    assert.ok(result.trace.some((entry) => (
      entry.status === 'rejected'
      && ['duplicate_query', 'duplicate_results', 'repeat_action'].includes(entry.reasonCode)
    )) || result.trace.some((entry) => entry.action === 'read'));
  });

  it('stops with repair_exhausted well before the hard cap when recovery cannot produce a valid query', async () => {
    let decisions = 0;
    const result = await new ResearchRunner().run({
      query: 'SubjectA official status',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 0,
          maxLlmTokens: 1000000,
          maxSteps: 50,
          maxQueriesPerStep: 3,
          maxRepairFailuresPerGap: 1,
          maxConsecutiveInvalidSteps: 100,
          autoReadTopK: 0,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return []; } },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              entities: ['SubjectA'],
              requiredAnswerSlots: [{ answerSlot: 'official_status', question: 'SubjectA official status' }],
            });
          }
          if (purpose === 'agent_decision') {
            decisions += 1;
            return JSON.stringify({ action: 'search', query: 'SubjectA official status', gapId: 'gap-1' });
          }
          if (purpose === 'gap_support') return JSON.stringify({ judgments: [] });
          return report();
        },
      },
    });
    assert.equal(result.quality.stopReason, 'safety_cap');
    assert.ok(['repair_exhausted', 'query_planner_exhausted'].includes(result.quality.stopDetail));
    assert.ok(decisions < 20);
    assert.ok(result.quality.budget.usage.llmTokens < 1000000);
    assert.ok(result.quality.metrics.recovery.blockedGaps.length > 0);
    assert.ok(result.quality.limitations.some((line) => /blocked slots/i.test(line)));
  });

  it('rejects empty bullets during report validation', () => {
    const check = emptyBulletLines('# Research Report\n\n## Key Findings\n-\n- Real finding [1.1]\n');
    assert.equal(check.length, 1);
  });

  it('keeps exploring when the token floor is reached but a required slot is still missing', async () => {
    const searches = [];
    const result = await new ResearchRunner().run({
      query: 'SubjectA official status',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 20, maxLlmTokens: 200000, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(searchQuery) {
        searches.push(searchQuery);
        return [{
          title: 'Weather',
          url: 'https://news.example.com/weather',
          content: 'This long article discusses weather patterns, rainfall totals, and agricultural cycles without mentioning SubjectA.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor([
        { action: 'search', query: 'SubjectA official', gapId: 'gap-1', reasonCode: 'search' },
        { action: 'read', sourceIds: ['https://news.example.com/weather'], gapId: 'gap-1', reasonCode: 'read' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
        { action: 'search', query: 'SubjectA site:docs.example.com', gapId: 'gap-2', reasonCode: 'repair' },
        { action: 'answer', reasonCode: 'evidence_sufficient' },
      ], {
        onProfile: () => JSON.stringify({
          requiredAnswerSlots: [{ answerSlot: 'SubjectA', question: 'SubjectA official status', priority: 'critical' }],
          minIndependentSources: 1,
        }),
        onGapSupport: () => JSON.stringify({
          judgments: [{
            gapId: 'gap-2',
            verdict: 'unsupported',
            quote: 'weather patterns, rainfall totals, and agricultural cycles without mentioning',
          }],
        }),
      }),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(searches.length >= 2);
    assert.ok((result.quality.limitations || []).some((line) => /unresolved|slot|required/i.test(line)));
  });

  it('honors provider maxQuestionConcurrency during exploratory search', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await new ResearchRunner().run({
      query: 'SubjectA official status',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        concurrency: 3,
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 3, maxQueriesPerStep: 3, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: {
        capabilities: { maxQuestionConcurrency: 1 },
        async search() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => { setTimeout(resolve, 15); });
          active -= 1;
          return [{ title: 'SubjectA', url: `https://docs.example.com/${maxActive}`, snippet: 'SubjectA official status' }];
        },
      },
      llm: llmFor([
        {
          action: 'search',
          query: 'SubjectA one',
          queries: ['SubjectA one', 'SubjectA two', 'SubjectA three'],
          queryOrigin: 'user_query',
          gapId: 'gap-1',
        },
        { action: 'answer', reasonCode: 'done' },
      ]),
    });
    assert.equal(maxActive, 1);
    assert.ok(result.trace.some((entry) => entry.action === 'search'));
  });

  it('does not consume repair budget on transient provider errors', async () => {
    const result = await new ResearchRunner().run({
      query: 'SubjectA official status',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 0,
          maxLlmTokens: 0,
          maxSteps: 6,
          maxRepairFailuresPerGap: 1,
          maxConsecutiveInvalidSteps: 3,
          autoReadTopK: 0,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: {
        async search() {
          throw new SearchProviderError('slow down', { code: 'rate_limited', retryable: true });
        },
      },
      llm: llmFor(Array.from({ length: 8 }, (_, index) => ({
        action: 'search',
        query: `SubjectA official documents ${index}`,
        queryOrigin: 'user_query',
        gapId: 'gap-1',
      }))),
    });
    assert.notEqual(result.quality.stopDetail, 'repair_exhausted');
    assert.ok(!(result.gaps || []).some((gap) => gap.blockedReason === 'repair_exhausted'));
    assert.ok((result.quality.metrics.recovery.transientFailures || 0) >= 1);
  });

  it('marks safety_cap with open required slots as incomplete', async () => {
    const result = await new ResearchRunner().run({
      query: 'SubjectA official status',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 0,
          maxLlmTokens: 0,
          maxSteps: 2,
          maxRepairFailuresPerGap: 1,
          maxConsecutiveInvalidSteps: 100,
          autoReadTopK: 0,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return []; } },
      llm: llmFor([
        { action: 'search', query: 'SubjectA official status', queryOrigin: 'user_query', gapId: 'gap-1' },
        { action: 'search', query: 'SubjectA official status two', queryOrigin: 'user_query', gapId: 'gap-1' },
      ], {
        onProfile: () => JSON.stringify({
          requiredAnswerSlots: [{ answerSlot: 'official_status', question: 'SubjectA official status' }],
        }),
      }),
    });
    assert.equal(result.quality.stopReason, 'safety_cap');
    assert.equal(result.quality.completionStatus, 'incomplete');
    assert.ok(['pass_with_warnings', 'fail', 'pass'].includes(result.quality.gate));
  });
});
