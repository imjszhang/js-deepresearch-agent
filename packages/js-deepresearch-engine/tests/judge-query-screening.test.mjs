import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueryScreening, screenPlannedQueries } from '../src/research/judge-query-screening.mjs';
import { filterDuplicateQueries } from '../src/research/strategies/exploratory-planning.mjs';
import { createResearchProviders } from '../src/index.mjs';

function noulJudge(score, { status = 200, features = { queryScreening: true }, batchSize } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (status !== 200) return new globalThis.Response('busy', { status });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: score(id, body.state) }]));
    return new globalThis.Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 3, output_tokens: 1 } }));
  };
  const { judge } = createResearchProviders({ judge: { provider: 'jev', apiKey: 'k-test', fetch, features, ...(batchSize ? { batchSize } : {}) } });
  return { judge, requests };
}

const gap = { id: 'gap-1', question: 'Atlas license', slotSupport: { missingFacets: ['license name'] }, searchedQueries: ['atlas license'] };
const planned = ['site:atlas.example.com "MIT license" Atlas', 'Atlas pricing history', 'what license does atlas use'];

function scorer(state) {
  return (id) => {
    const query = state.queries[Number(id.slice(1, id.indexOf('_')))].text;
    if (id.endsWith('_target')) return query.includes('pricing') ? 0.1 : query.includes('site:') ? 0.95 : 0.6;
    return query.startsWith('what license') ? 0.97 : 0.2;
  };
}

test('[V26] screening reorders and marks same-intent duplicates without changing any query text', async () => {
  const { judge, requests } = noulJudge((id, state) => scorer(state)(id));
  const screening = await screenPlannedQueries(judge, { gap, queries: planned, searched: gap.searchedQueries });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].state.queries.map((item) => item.text), planned);
  assert.deepEqual(screening.ordered, ['site:atlas.example.com "MIT license" Atlas', 'Atlas pricing history']);
  assert.deepEqual(screening.duplicates, [{ query: 'what license does atlas use', reason: 'jev_intent', duplicateOf: 'atlas license', probability: 0.97 }]);
  const objects = planned.map((query, index) => ({ query, queryOrigin: 'llm_planner', index }));
  const applied = applyQueryScreening(objects, screening, (item) => item.query);
  assert.deepEqual(applied.map((item) => item.query), screening.ordered);
  assert.ok(applied.every((item) => item.queryOrigin === 'llm_planner' && planned.includes(item.query)));
});

test('screening batches questions, and degraded or disabled judges keep the planner order', async () => {
  const batched = noulJudge((id, state) => scorer(state)(id), { batchSize: 4 });
  const result = await screenPlannedQueries(batched.judge, { gap, queries: planned, searched: gap.searchedQueries });
  assert.deepEqual(batched.requests.map((body) => Object.keys(body.questions).length), [4, 2]);
  assert.equal(result.ordered.length, 2);
  const degraded = noulJudge(() => 1, { status: 429 });
  const kept = await screenPlannedQueries(degraded.judge, { gap, queries: planned, searched: gap.searchedQueries });
  assert.deepEqual(kept.ordered, planned);
  assert.deepEqual(kept.duplicates, []);
  assert.equal(kept.trace.degraded, 1);
  const off = noulJudge(() => 1, { features: { readPriority: true } });
  assert.deepEqual((await screenPlannedQueries(off.judge, { gap, queries: planned })).ordered, planned);
  assert.equal(off.requests.length, 0);
});

test('legacy duplicate filtering keeps embedding rejections and adds Jev intent rejections with distinct reasons', async () => {
  const { judge } = noulJudge((id, state) => scorer(state)(id));
  const state = {
    gaps: [gap], embeddingTraces: [], duplicates: 0,
    searchedQueries: () => ['atlas license'], getGap: () => gap, noteDuplicateQuery() { this.duplicates += 1; },
  };
  const queryMemory = { async filterDuplicates(candidates) {
    return { accepted: candidates.filter((item) => !item.includes('pricing')), rejected: [{ query: 'atlas pricing history', reason: 'semantic_scope', duplicateOf: 'atlas cost' }] };
  } };
  const accepted = await filterDuplicateQueries(planned, { state, queryMemory, gapId: 'gap-1', judge });
  assert.deepEqual(accepted, ['site:atlas.example.com mit license atlas']);
  assert.deepEqual(state.embeddingTraces.map((item) => item.rejectedAt).sort(), ['jev_intent', 'semantic_scope']);
  assert.equal(state.duplicates, 2);
  const withoutJudge = { ...state, embeddingTraces: [], duplicates: 0 };
  assert.deepEqual(await filterDuplicateQueries(planned, { state: withoutJudge, queryMemory, gapId: 'gap-1' }),
    ['site:atlas.example.com mit license atlas', 'what license does atlas use']);
});
