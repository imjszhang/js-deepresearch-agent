import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPassageOrder, judgePassageOrder } from '../src/research/judge-passage-order.mjs';
import { judgeOpenSlotSupport } from '../src/research/gap-slot-support.mjs';
import { createResearchProviders } from '../src/index.mjs';

function noulJudge(score, { status = 200, features = { passageOrder: true }, batchSize, allowLocalCorpus } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (status !== 200) return new globalThis.Response('busy', { status });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: score(id, body.state) }]));
    return new globalThis.Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 3, output_tokens: 1 } }));
  };
  const { judge } = createResearchProviders({ judge: { provider: 'jev', apiKey: 'k-test', fetch, features, ...(batchSize ? { batchSize } : {}), ...(allowLocalCorpus ? { allowLocalCorpus } : {}) } });
  return { judge, requests };
}

const textOf = (id, state) => state.groups[Number(id.slice(1, id.indexOf('_')))].passages[Number(id.slice(id.indexOf('_p') + 2))].text;
const preferLicense = (id, state) => (textOf(id, state).includes('license') ? 0.9 : 0.2);
const preferAbout = (id, state) => (textOf(id, state).includes('research teams') ? 0.9 : 0.2);

test('passage order groups are batched, degraded groups keep their order and local corpus text stays local', async () => {
  const groups = [
    { key: 'a', focus: 'license', passages: [{ id: 'a1', text: 'pricing', url: 'https://x.example' }, { id: 'a2', text: 'license MIT', url: 'https://x.example' }] },
    { key: 'b', focus: 'license', passages: [{ id: 'b1', text: 'history', url: 'https://y.example' }, { id: 'b2', text: 'license terms', url: 'https://y.example' }] },
    { key: 'local', focus: 'license', passages: [{ id: 'l1', text: 'x', url: 'file:///corpus/a.md' }, { id: 'l2', text: 'license', url: 'file:///corpus/b.md' }] },
    { key: 'single', focus: 'license', passages: [{ id: 's1', text: 'license', url: 'https://z.example' }] },
  ];
  const batched = noulJudge(preferLicense, { batchSize: 2 });
  const { orders, trace } = await judgePassageOrder(batched.judge, { groups });
  assert.equal(batched.requests.length, 2);
  assert.deepEqual(orders.get('a'), ['a2', 'a1']);
  assert.deepEqual(orders.get('b'), ['b2', 'b1']);
  assert.equal(orders.has('local'), false);
  assert.equal(orders.has('single'), false);
  assert.equal(trace.skippedLocal, 1);
  assert.deepEqual(applyPassageOrder(groups[0].passages, orders.get('a')).map((item) => item.id), ['a2', 'a1']);
  const degraded = noulJudge(preferLicense, { status: 502 });
  const kept = await judgePassageOrder(degraded.judge, { groups });
  assert.equal(kept.orders.size, 0);
  assert.equal(kept.trace.degraded, 1);
  const off = noulJudge(preferLicense, { features: { readPriority: true } });
  assert.equal((await judgePassageOrder(off.judge, { groups })).orders.size, 0);
  assert.equal(off.requests.length, 0);
});

const gap = { id: 'gap-1', question: 'Atlas license', answerSlot: 'license', kind: 'slot', requiredSlot: true, priority: 'normal', status: 'body_read', evidenceCriteria: [] };
const findings = [
  { gapId: 'gap-1', sources: [{ id: 'https://a.example/pricing', url: 'https://a.example/pricing', content: 'Atlas pricing is free for local use and paid for teams.', fetchStatus: 'ok' }] },
  { gapId: 'gap-1', sources: [{ id: 'https://b.example/license', url: 'https://b.example/license', content: 'Atlas is distributed under the MIT license by its publisher.', fetchStatus: 'ok' }] },
  { gapId: 'gap-1', sources: [{ id: 'https://c.example/about', url: 'https://c.example/about', content: 'Atlas processes local documents for research teams.', fetchStatus: 'ok' }] },
];

async function supportRun(judge) {
  const prompts = [];
  const result = await judgeOpenSlotSupport({
    query: 'Atlas license', gaps: [{ ...gap }], findings, judge, cache: new Map(),
    llm: { async complete({ messages }) {
      prompts.push(messages.map((item) => item.content).join('\n'));
      return JSON.stringify({ judgments: [{ gapId: 'gap-1', verdict: 'unsupported', missingFacets: ['license'] }] });
    } },
  });
  const prompt = prompts[0];
  const ids = findings.map((item) => item.sources[0].url).filter((url) => prompt.includes(url));
  const order = [...ids].sort((a, b) => prompt.indexOf(a) - prompt.indexOf(b));
  return { result, order, verdicts: result.judgments.map((item) => item.verdict) };
}

test('slot support sees the same selected passages with Jev ordering, only in a different order and under a distinct cache key', async () => {
  const off = await supportRun(null);
  const on = await supportRun(noulJudge(preferAbout).judge);
  const degraded = await supportRun(noulJudge(preferAbout, { status: 503 }).judge);
  assert.deepEqual([...on.order].sort(), [...off.order].sort());
  assert.deepEqual(on.result.selections[0].selectedSourceIds.slice().sort(), off.result.selections[0].selectedSourceIds.slice().sort());
  assert.equal(on.order[0], 'https://c.example/about');
  assert.notEqual(off.order[0], 'https://c.example/about');
  assert.deepEqual(degraded.order, off.order);
  assert.deepEqual(on.verdicts, off.verdicts);
  const offCache = new Map();
  const onCache = new Map();
  const llm = { async complete() { return JSON.stringify({ judgments: [{ gapId: 'gap-1', verdict: 'unsupported', missingFacets: [] }] }); } };
  await judgeOpenSlotSupport({ query: 'Atlas license', gaps: [{ ...gap }], findings, cache: offCache, llm });
  await judgeOpenSlotSupport({ query: 'Atlas license', gaps: [{ ...gap }], findings, cache: onCache, llm, judge: noulJudge(preferAbout).judge });
  assert.notDeepEqual([...onCache.keys()], [...offCache.keys()]);
  const degradedCache = new Map();
  await judgeOpenSlotSupport({ query: 'Atlas license', gaps: [{ ...gap }], findings, cache: degradedCache, llm, judge: noulJudge(preferAbout, { status: 503 }).judge });
  assert.deepEqual([...degradedCache.keys()], [...offCache.keys()]);
});

test('claim validation compares the same passages with Jev ordering and never receives a Jev verdict', async () => {
  const { EvidenceStore } = await import('../src/research/evidence-store.mjs');
  const { normalizeClaimCandidates } = await import('../src/research/claim-candidates.mjs');
  const { buildClaimGraph } = await import('../src/research/claim-graph.mjs');
  const { validateResearchClaims } = await import('../src/research/claim-validation.mjs');
  const build = () => {
    const store = new EvidenceStore();
    const main = store.register({ url: 'https://atlas.test/manual', content: 'Atlas version 1 uses license MIT.', fetchStatus: 'ok' }, 'g1');
    for (const [url, content] of [['https://a.test/1', 'Atlas version 1 license notes from a blog.'], ['https://b.test/2', 'Atlas version 1 license changed to Apache in a fork.'], ['https://c.test/3', 'Atlas version 1 license text mirror.']]) {
      store.chunks(store.register({ url, content, fetchStatus: 'ok' }, 'g1').documentVersionId);
    }
    const p = store.chunks(main.documentVersionId)[0];
    const [candidate] = normalizeClaimCandidates([{ proposition: 'Atlas version 1 uses license MIT.', kind: 'source_attributed', conditions: ['version 1'],
      quote: 'Atlas version 1 uses license MIT.', supportingPassageIds: [p.id] }], [p]);
    const gaps = [{ id: 'g1', question: 'Atlas license', taskType: 'fact', status: 'verified', requiredSlot: true,
      slotSupport: { quoteAnchored: true, verdict: 'supported', quote: p.text, answer: 'MIT', supportingPassageIds: [p.id], missingFacets: [], claimCandidates: [candidate] } }];
    return { store, gaps, graph: buildClaimGraph({ gaps, passages: [...store.passages.values()] }) };
  };
  const run = async (judge) => {
    const { store, gaps, graph } = build();
    const seen = [];
    const cache = {};
    await validateResearchClaims({ graph, store, gaps, query: 'Atlas license', judge, cache, llm: { async complete({ messages }) {
      const input = JSON.parse(messages[1].content);
      seen.push(input.claims[0].comparisonPassages.map((item) => item.text));
      return JSON.stringify({ judgments: input.claims.map((claim) => ({ claimId: claim.claimId, atomic: true, verdict: 'supported', counterPassageIds: [],
        bindings: claim.tasks.map((task) => ({ taskId: task.taskId, answerRelation: 'supported' })) })) });
    } } });
    return { order: seen[0], verdict: graph.records[0].evaluation.verdict, keys: Object.keys(cache) };
  };
  const preferMirror = (id, state) => (textOf(id, state).includes('mirror') ? 0.95 : 0.1);
  const off = await run(null);
  const on = await run(noulJudge(preferMirror).judge);
  const degraded = await run(noulJudge(preferMirror, { status: 500 }).judge);
  assert.ok(off.order.length > 1);
  assert.deepEqual([...on.order].sort(), [...off.order].sort());
  assert.ok(on.order[0].includes('mirror'));
  assert.ok(!off.order[0].includes('mirror'));
  assert.equal(on.verdict, off.verdict);
  assert.notDeepEqual(on.keys, off.keys);
  assert.deepEqual(degraded.order, off.order);
  assert.deepEqual(degraded.keys, off.keys);
});
