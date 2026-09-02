import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  planSearchQueries,
  validatePlannedQuery,
  allowedSiteHosts,
  attachPlannedQueries,
  QUERY_ORIGINS,
} from '../src/research/search-query-planner.mjs';

function llmJson(payload, { truncated = false } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async complete() {
      calls += 1;
      return JSON.stringify(payload);
    },
    getLastCallMetadata() {
      return { finishReason: truncated && calls === 1 ? 'length' : 'stop' };
    },
  };
}

const gap = {
  id: 'gap-finance',
  question: '智谱AI的营收、利润及现金流状况如何?',
  answerSlot: 'financial_performance',
  evidenceCriteria: ['audited_financials'],
  requiredHosts: ['sse.com.cn'],
};

describe('search query planner', () => {
  it('plans natural-language queries for each mode without leaking identifiers', async () => {
    for (const mode of ['initial', 'repair', 'challenge', 'angle_change', 'recovery']) {
      const result = await planSearchQueries({
        llm: llmJson({
          queries: [{
            query: '智谱AI 2024 2025 营收 利润 招股书',
            targetGapId: 'gap-finance',
            intent: mode,
            expectedEvidence: '招股书',
            sourceType: 'filing',
          }],
        }),
        mode,
        query: '全面研究智谱这家公司',
        gap,
        brief: { entities: ['智谱AI'] },
        limit: 1,
      });
      assert.equal(result.ok, true, mode);
      assert.equal(result.planned[0].queryOrigin, QUERY_ORIGINS.llmPlanner);
      assert.equal(result.planned[0].plannerMode, mode);
      assert.ok(!/financial_performance|audited_financials/.test(result.queries[0]));
    }
  });

  it('rejects snake_case identifiers and old templates', () => {
    assert.equal(validatePlannedQuery('智谱AI financial_performance', { gap }).reason, 'internal_identifier');
    assert.equal(validatePlannedQuery('beta safety primary source evidence', { gap: { question: 'beta safety' } }).reason, 'forbidden_template');
    assert.equal(validatePlannedQuery('智谱AI 营收 利润 招股书', { gap, entities: ['智谱AI'] }).ok, true);
  });

  it('enforces site policy and local scope', async () => {
    assert.deepEqual(allowedSiteHosts({
      gap: { requiredHosts: ['gov.cn'], preferredHosts: ['caixin.com'] },
      siteQueryMode: 'confirmed',
      observedHosts: [],
    }), ['gov.cn']);
    const local = await planSearchQueries({
      llm: llmJson({ queries: [{ query: 'site:gov.cn 智谱 备案' }] }),
      mode: 'repair',
      query: '智谱',
      gap,
      evidenceScope: 'local',
    });
    assert.equal(local.ok, false);
    assert.equal(local.failure, 'local_site_forbidden');
    const site = await planSearchQueries({
      llm: llmJson({ queries: [{ query: 'site:example.com 智谱 营收' }] }),
      mode: 'repair',
      query: '智谱',
      gap,
      siteQueryMode: 'confirmed',
    });
    assert.equal(site.ok, false);
    assert.equal(site.failure, 'site_mode_violation');
  });

  it('rejects duplicates and does not invent a fallback query', async () => {
    const result = await planSearchQueries({
      llm: llmJson({ queries: [{ query: '智谱AI 营收 招股书' }] }),
      mode: 'recovery',
      query: '智谱',
      gap,
      searchedQueries: ['智谱AI 营收 招股书'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'all_duplicates');
    assert.deepEqual(result.queries, []);
  });

  it('retries truncated JSON once and then fails closed', async () => {
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        return calls === 1 ? '{"queries":[' : JSON.stringify({
          queries: [{ query: '智谱AI 监管 备案', targetGapId: 'gap-finance' }],
        });
      },
      getLastCallMetadata() {
        return { finishReason: calls === 1 ? 'length' : 'stop' };
      },
    };
    const result = await planSearchQueries({
      llm,
      mode: 'repair',
      query: '智谱',
      gap,
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.ok(calls >= 2);
  });

  it('does not call the LLM when the requested limit is empty', async () => {
    let calls = 0;
    const result = await planSearchQueries({
      llm: { async complete() { calls += 1; return JSON.stringify({ queries: [{ query: 'should not run' }] }); } },
      mode: 'initial',
      query: 'topic',
      limit: 0,
    });
    assert.equal(calls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'empty_limit');
    assert.deepEqual(result.queries, []);
  });

  it('propagates abort without synthesizing queries', async () => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await assert.rejects(
      planSearchQueries({
        llm: { async complete() { throw error; } },
        mode: 'initial',
        query: 'topic',
      }),
      (err) => err.name === 'AbortError',
    );
  });

  it('does not invent queries when planner budget is exhausted', async () => {
    const error = Object.assign(new Error('Research budget exhausted: llmTokens'), {
      name: 'BudgetExceededError',
      kind: 'llmTokens',
    });
    await assert.rejects(
      planSearchQueries({
        llm: { async complete() { throw error; } },
        mode: 'repair',
        query: 'topic',
        gap,
      }),
      (err) => err.name === 'BudgetExceededError',
    );
  });

  it('returns no_llm without synthesizing queries', async () => {
    const result = await planSearchQueries({
      mode: 'initial',
      query: 'topic',
      limit: 2,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'no_llm');
    assert.deepEqual(result.queries, []);
  });

  it('rewrites site fallback without site:', async () => {
    const result = await planSearchQueries({
          llm: llmJson({ queries: [{ query: '智谱AI 监管合规 备案' }] }),
      mode: 'site_fallback',
      query: '智谱',
      gap: { id: 'gap-2', question: '智谱AI监管合规' },
      siteFallbackFor: 'site:cac.gov.cn 生成式人工智能服务 备案 智谱',
    });
    assert.equal(result.ok, true);
    assert.ok(!/site:/.test(result.queries[0]));
    assert.equal(result.planned[0].siteFallbackOf, 'site:cac.gov.cn 生成式人工智能服务 备案 智谱');
  });

  it('executes the unused original query once without calling the planner', async () => {
    let calls = 0;
    const llm = {
      async complete() {
        calls += 1;
        return JSON.stringify({ queries: [{ query: 'should not run' }] });
      },
    };
    const first = await attachPlannedQueries({
      action: 'search',
      query: '全面研究智谱这家公司',
      gapId: 'gap-finance',
    }, {
      llm,
      query: '全面研究智谱这家公司',
      searchedQueries: [],
    });
    assert.equal(first.action.queryOrigin, QUERY_ORIGINS.userQuery);
    assert.equal(first.action.query, '全面研究智谱这家公司');
    assert.equal(calls, 0);
    const second = await attachPlannedQueries({
      action: 'search',
      query: '全面研究智谱这家公司',
      gapId: 'gap-finance',
    }, {
      llm,
      query: '全面研究智谱这家公司',
      searchedQueries: ['全面研究智谱这家公司'],
      gap,
      limit: 1,
    });
    assert.ok(calls >= 1);
    assert.notEqual(second.action.queryOrigin, QUERY_ORIGINS.userQuery);
    assert.ok(!second.plan?.ok);
    assert.equal(second.action.query, '');
  });

  it('accepts a Chinese local query for an English slot when it overlaps the research question', async () => {
    const result = await planSearchQueries({
      llm: llmJson({
        queries: [{ query: '星河智算 2024 行政处罚 金额 事由 整改', targetGapId: 'gap-2' }],
      }),
      mode: 'initial',
      query: '星河智算 2024 年监管处罚的金额、事由和整改措施是什么？',
      gap: {
        id: 'gap-2',
        question: 'What was the monetary amount of the regulatory penalty imposed on 星河智算 in 2024?',
        answerSlot: 'penalty_amount',
        claimFamily: 'financial_penalty',
        evidenceCriteria: ['Official government announcement'],
      },
      brief: {
        query: '星河智算 2024 年监管处罚的金额、事由和整改措施是什么？',
        entities: ['星河智算'],
      },
      evidenceScope: 'local',
      limit: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.queries[0], '星河智算 2024 行政处罚 金额 事由 整改');
  });

  it('reports scope_mismatch instead of invalid JSON when parsed queries miss the slot', async () => {
    const result = await planSearchQueries({
      llm: llmJson({
        queries: [{ query: '星河智算 模型 专利 技术壁垒', targetGapId: 'gap-2' }],
      }),
      mode: 'initial',
      query: '星河智算 2024 年监管处罚的金额、事由和整改措施是什么？',
      gap: {
        id: 'gap-2',
        question: 'What was the monetary amount of the regulatory penalty imposed on 星河智算 in 2024?',
        answerSlot: 'penalty_amount',
        claimFamily: 'financial_penalty',
      },
      brief: {
        query: '星河智算 2024 年监管处罚的金额、事由和整改措施是什么？',
        entities: ['星河智算'],
      },
      limit: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'scope_mismatch');
    assert.equal(result.dedup.rejected[0].reason, 'scope_mismatch');
    assert.deepEqual(result.queries, []);
  });
});
