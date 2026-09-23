import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionScheduler, actionKey } from '../src/research/adaptive/action-scheduler.mjs';
import { judgeReadPriorities } from '../src/research/judge-read-priority.mjs';
import { createResearchProviders } from '../src/index.mjs';

function noulJudge({ score = () => 0.5, status = 200, features = { readPriority: true }, extra = {} } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (status !== 200) return new globalThis.Response('unavailable', { status });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: score(id, body) }]));
    return new globalThis.Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }));
  };
  const { judge } = createResearchProviders({ judge: { provider: 'jev', apiKey: 'k-test', fetch, features, ...extra } });
  return { judge, requests };
}

const read = (id, extra = {}) => ({ type: 'read_candidate', targetTaskIds: ['gap-1'], required: true, inputRefs: { sourceIds: [id] }, ...extra });

test('readPriority orders reads only after required and task-turn tiers and never changes action identity', () => {
  assert.equal(actionKey(read('a')), actionKey(read('a', { readPriority: 0.9 })));
  const scheduler = new ActionScheduler();
  scheduler.enqueue(read('low', { readPriority: 0.1 }));
  scheduler.enqueue(read('high', { readPriority: 0.9 }));
  scheduler.enqueue(read('optional', { required: false, targetTaskIds: ['gap-2'], readPriority: 1 }));
  scheduler.enqueue({ type: 'inspect_document', targetTaskIds: ['gap-1'], required: true, inputRefs: { passageIds: ['p'] } });
  assert.equal(scheduler.next().type, 'inspect_document');
  const restored = new ActionScheduler(JSON.parse(JSON.stringify(scheduler.export())));
  const order = [];
  for (let action = restored.next(); action; action = restored.next()) {
    if (action.type === 'read_candidate') order.push(action.inputRefs.sourceIds[0]);
    restored.begin(action);
    restored.apply(restored.receipt(action, { execution: 'succeeded' }));
  }
  assert.deepEqual(order, ['high', 'low', 'optional']);
  assert.equal(restored.export().actions.find((item) => item.inputRefs.sourceIds?.[0] === 'high').readPriority, 0.9);
});

test('[V26] old scheduler snapshots without readPriority keep their original dispatch order', () => {
  const scheduler = new ActionScheduler();
  for (const id of ['first', 'second', 'third']) scheduler.enqueue(read(id));
  const snapshot = JSON.parse(JSON.stringify(scheduler.export()));
  assert.ok(snapshot.actions.every((item) => !('readPriority' in item)));
  const restored = new ActionScheduler(snapshot);
  const order = [];
  for (let action = restored.next(); action; action = restored.next()) {
    order.push(action.inputRefs.sourceIds[0]);
    restored.begin(action);
    restored.apply(restored.receipt(action, { execution: 'succeeded' }));
  }
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('read priorities ask one noul per missing facet plus first party, batched to 40 questions and cached', async () => {
  const gap = { id: 'gap-1', question: 'Atlas pricing', slotSupport: { missingFacets: ['price', 'currency', 'effective date'] } };
  const candidates = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, url: `https://atlas.example.com/${index}`, title: `T${index}`, snippet: 'snippet' }));
  const { judge, requests } = noulJudge({ score: (id, body) => (id.endsWith('first_party') ? 0 : Number(body.state.candidates[Number(id.slice(1, id.indexOf('_')))].title.slice(1)) / 20) });
  const cache = new Map();
  const { priorities, trace } = await judgeReadPriorities(judge, { gap, candidates, cache });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((body) => Object.keys(body.questions).length), [40, 8]);
  assert.ok(requests.every((body) => Object.values(body.questions).every((question) => question.type === 'noul')));
  assert.equal(priorities.size, 12);
  assert.ok(priorities.get('s11') > priorities.get('s0'));
  assert.equal(trace.requests, 2);
  const again = await judgeReadPriorities(judge, { gap, candidates, cache });
  assert.equal(requests.length, 2);
  assert.equal(again.trace.cached, 12);
  await judgeReadPriorities(judge, { gap: { ...gap, slotSupport: { missingFacets: ['price'] } }, candidates: candidates.slice(0, 1), cache });
  assert.equal(requests.length, 3);
});

test('degraded, disabled and local-corpus scoring leaves candidates unscored instead of dropping them', async () => {
  const gap = { id: 'gap-1', question: 'Atlas pricing' };
  const candidates = [{ id: 'web', url: 'https://atlas.example.com' }, { id: 'local', url: 'file:///corpus/atlas.md' }];
  const degraded = noulJudge({ status: 503 });
  const result = await judgeReadPriorities(degraded.judge, { gap, candidates });
  assert.equal(result.priorities.size, 0);
  assert.equal(result.trace.degraded, 1);
  assert.equal(result.trace.skippedLocal, 1);
  assert.deepEqual(degraded.requests[0].state.candidates.map((item) => item.url), ['https://atlas.example.com']);
  const off = noulJudge({ features: { passageOrder: true } });
  assert.equal((await judgeReadPriorities(off.judge, { gap, candidates })).priorities.size, 0);
  assert.equal(off.requests.length, 0);
  assert.equal((await judgeReadPriorities(null, { gap, candidates })).priorities.size, 0);
});
