import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { buildPlannerFeedback, plannerFeedbackFromState } from '../src/research/planner-feedback.mjs';
import { planSearchQueries } from '../src/research/search-query-planner.mjs';

describe('planner feedback', () => {
  it('assembles rejected queries, duplicates, and recent outcomes without classifying them', () => {
    const feedback = buildPlannerFeedback({
      searchedQueries: ['智谱 招股书'],
      exhaustedAngles: ['site:zhipuai.cn 合规'],
      rejectedQueries: [{ query: 'bad template', reason: 'forbidden_template' }],
      filteredQueries: [{ query: 'site:cac.gov.cn 备案', reason: 'site_filtered_all' }],
      plannerRejections: [{ query: 'same as before', reason: 'all_duplicates', duplicateOf: '智谱 招股书' }],
      recentSearchOutcomes: [{
        query: 'site:cac.gov.cn 备案',
        outcome: 'site_filtered_all',
        resultCount: 0,
        siteRejectedCount: 8,
        respondedEngines: ['bing'],
        unresponsiveEngines: [['google', 'timeout']],
        snippets: [{ title: 'Off host', url: 'https://other.test', snippet: 'unrelated' }],
      }],
      queryMemoryEntries: [{ query: 'empty angle', status: 'empty' }],
    });
    assert.ok(feedback.rejectedQueries.some((item) => item.reason === 'site_filtered_all'));
    assert.ok(feedback.rejectedQueries.some((item) => item.duplicateOf === '智谱 招股书'));
    assert.equal(feedback.recentSearchOutcomes[0].outcome, 'site_filtered_all');
    assert.deepEqual(feedback.recentSearchOutcomes[0].respondedEngines, ['bing']);
  });

  it('round-trips optional searchOptions from the planner', async () => {
    const result = await planSearchQueries({
      llm: {
        async complete() {
          return JSON.stringify({
            queries: [{
              query: '智谱AI 监管合规',
              searchOptions: { engines: 'brave,google', language: 'zh', pageno: 2 },
            }],
          });
        },
      },
      query: '智谱',
      gap: { id: 'gap-2', question: '智谱AI监管合规' },
      limit: 1,
      recentSearchOutcomes: [{ query: '智谱', outcome: 'empty', respondedEngines: ['bing'] }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.planned[0].searchOptions, {
      engines: 'brave,google',
      language: 'zh',
      pageno: 2,
    });
  });

  it('feeds the previous failed search outcome into the next planner prompt', async () => {
    const state = new ResearchState({ query: '智谱' });
    state.recordSearchOutcome({
      query: 'site:example.test 智谱',
      queryOrigin: 'llm_planner',
      plannerMode: 'initial',
      gapId: 'gap-2',
      sources: [],
      resultCount: 0,
      returnedResultCount: 0,
      siteRejectedCount: 5,
      error: { message: 'SearXNG HTTP 400: Unknown language' },
      searchMeta: {
        respondedEngines: [],
        unresponsiveEngines: [['bing', 'timeout']],
      },
    });
    const feedback = plannerFeedbackFromState(state);
    assert.equal(feedback.recentSearchOutcomes[0].query, 'site:example.test 智谱');
    assert.ok(feedback.recentSearchOutcomes[0].outcome);

    let plannerUser = '';
    await planSearchQueries({
      llm: {
        async complete({ messages }) {
          plannerUser = messages.find((item) => item.role === 'user')?.content || '';
          return JSON.stringify({ queries: [{ query: '智谱 监管合规 公开文件' }] });
        },
      },
      query: '智谱',
      gap: { id: 'gap-2', question: '智谱监管合规' },
      limit: 1,
      ...feedback,
    });
    assert.match(plannerUser, /site:example\.test 智谱/);
    assert.match(plannerUser, /recentSearchOutcomes/);
    const payload = JSON.parse(plannerUser);
    assert.ok(payload.recentSearchOutcomes.some((item) => item.query === 'site:example.test 智谱'));
  });
});
