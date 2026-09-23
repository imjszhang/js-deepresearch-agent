import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchRunner } from '../src/index.mjs';
import { FileRunRecorder } from '../src/research/run-recorder.mjs';
import { canonicalLlm, body } from './helpers/canonical-llm.mjs';

const baseSettings = { llm: {}, search: {}, research: { strategy: 'exploratory',
  exploratory: { maxSteps: 8, minLlmTokens: 0, maxLlmTokens: 100000, autoReadTopK: 0 },
  focused: { fetchMode: 'disabled', evidencePassages: { embedding: { enabled: false } } } } };

function scriptedJudge(features, score = () => 0.6) {
  const calls = [];
  return {
    calls,
    config: {
      provider: 'jev', dialect: 'typesafe', model: 'jev-1.13.0', features,
      async judge({ questions, state }) {
        calls.push({ questions, state });
        const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'noul'
          ? { type: 'noul', noul: score(id, state) }
          : { type: 'choice', choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, index) => [key, index === 0 ? 1 : 0])), confidence: 1 }]));
        return { model: 'jev-1.13.0', answers, usage: { known: true, inputTokens: 10, outputTokens: 1, tokens: 11 } };
      },
    },
  };
}

function searchWith(results) {
  return { async search() { return results; } };
}

const results = [
  { title: 'Atlas documentation', url: 'https://atlas.example.com/docs', snippet: 'Atlas docs', content: body, fetchStatus: 'ok', contentOrigin: 'provided' },
];

function withJudge(judge) {
  return { ...baseSettings, research: { ...baseSettings.research, providers: { judge } } };
}

test('default configuration creates no judge calls and records no judge artifacts', async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-judge-default-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, ...rest) => { fetched.push(String(url)); return originalFetch(url, ...rest); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: baseSettings, search: searchWith(results), llm: canonicalLlm(),
    recorder: new FileRunRecorder({ sessionDir, strategy: 'exploratory', query: '调研 Atlas 这个产品' }) });
  assert.equal(result.executionVersion, 2);
  assert.ok(!fetched.some((url) => url.includes('typesafe')));
  assert.ok(!fs.readdirSync(path.join(sessionDir, 'calls')).some((name) => name.startsWith('judge-')));
  const serialized = JSON.stringify({ trace: result.trace, quality: result.quality });
  assert.ok(!serialized.includes('"judge_'));
  assert.equal(result.quality.budget.limits?.judgeRequests, undefined);
});

test('an enabled judge with every feature off is never constructed', async () => {
  const judge = scriptedJudge({});
  await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: withJudge(judge.config), search: searchWith(results), llm: canonicalLlm() });
  assert.equal(judge.calls.length, 0);
});

test('read priority is attached to queued reads without changing which candidates are queued', async (t) => {
  const { registerContentFetchHandler, resetContentFetchHandlers } = await import('../src/research/content-resolver.mjs');
  registerContentFetchHandler(async () => ({ status: 'ok', title: 'Atlas', content: body }));
  t.after(() => resetContentFetchHandlers());
  const unread = [
    { title: 'Atlas license notes', url: 'https://atlas.example.com/license', snippet: 'Atlas license' },
    { title: 'Atlas blog', url: 'https://blog.example.org/atlas', snippet: 'Atlas blog' },
  ];
  const judge = scriptedJudge({ readPriority: true }, (id, state) => (state.candidates?.[Number(id.slice(1, id.indexOf('_')))]?.url.includes('license') ? 0.9 : 0.1));
  const full = (value) => ({ ...value, research: { ...value.research, focused: { ...value.research.focused, fetchMode: 'full' } } });
  const readsOf = (result) => result.trace.filter((entry) => entry.action === 'read').map((entry) => entry.sourceIds[0]);
  const off = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: full(baseSettings), search: searchWith(unread), llm: canonicalLlm() });
  const on = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: full(withJudge(judge.config)), search: searchWith(unread), llm: canonicalLlm() });
  assert.equal(readsOf(off)[0], 'https://blog.example.org/atlas');
  assert.equal(readsOf(on)[0], 'https://atlas.example.com/license');
  assert.deepEqual(judge.calls[0].state.candidates.map((item) => item.url).sort(), unread.map((item) => item.url).sort());
  assert.ok(judge.calls.every((call) => Object.values(call.questions).every((question) => question.type === 'noul')));
  assert.equal(on.trace.filter((entry) => entry.action === 'judge_read_priority').length, 1);
  assert.equal(on.quality.readiness.pass, off.quality.readiness.pass);
});

test('query screening keeps planner text and provenance while ordering queued searches', async () => {
  const judge = scriptedJudge({ queryScreening: true }, (id, state) => (id.endsWith('_target') ? (state.queries[Number(id.slice(1, id.indexOf('_')))].ref === 'q0' ? 0.1 : 0.9) : 0));
  const on = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: withJudge(judge.config), search: searchWith(results), llm: canonicalLlm() });
  const screenings = on.trace.filter((entry) => entry.action === 'judge_query_screening');
  const searches = on.trace.filter((entry) => entry.action === 'search' && entry.queryOrigin === 'llm_planner');
  const plannerTexts = judge.calls[0].state.queries.map((item) => item.text);
  assert.equal(screenings.length, 1);
  assert.deepEqual(screenings[0].order, [plannerTexts[1], plannerTexts[0]]);
  assert.equal(searches[0].query, plannerTexts[1]);
  assert.ok(searches.every((entry) => plannerTexts.includes(entry.query)));
  const off = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: baseSettings, search: searchWith(results), llm: canonicalLlm() });
  const offSearches = off.trace.filter((entry) => entry.action === 'search' && entry.queryOrigin === 'llm_planner');
  assert.equal(offSearches[0].query, plannerTexts[0]);
  assert.equal(on.quality.readiness.pass, off.quality.readiness.pass);
});

test('a judge that is always unavailable leaves every feature on the original path', async () => {
  const { JudgeProviderError } = await import('../src/index.mjs');
  let attempts = 0;
  const unavailable = { provider: 'jev', dialect: 'typesafe', model: 'jev-1.13.0',
    features: { sourceAssessment: true, readPriority: true, queryScreening: true, passageOrder: true },
    async judge() { attempts += 1; throw new JudgeProviderError('unavailable', 'JUDGE_SERVER_ERROR', { status: 503, provider: 'jev' }); } };
  const off = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: baseSettings, search: searchWith(results), llm: canonicalLlm() });
  const degraded = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: withJudge(unavailable), search: searchWith(results), llm: canonicalLlm() });
  assert.ok(attempts > 0 && attempts <= 3);
  assert.equal(degraded.report, off.report);
  assert.deepEqual(degraded.reportPlan.bindings, off.reportPlan.bindings);
  assert.equal(degraded.quality.gate, off.quality.gate);
  assert.equal(degraded.quality.completionStatus, off.quality.completionStatus);
  assert.equal(degraded.quality.budget.usage.llmTokens, off.quality.budget.usage.llmTokens);
  assert.equal(degraded.quality.budget.floorStatus, off.quality.budget.floorStatus);
});

test('maximally positive Jev answers cannot turn a failed claim or gate into a pass', async () => {
  const eager = scriptedJudge({ sourceAssessment: true, readPriority: true, queryScreening: true, passageOrder: true }, (id) => (id.includes('_same_') ? 0 : 1));
  const off = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: baseSettings, search: searchWith(results), llm: canonicalLlm({ conflict: true }) });
  const on = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: withJudge(eager.config), search: searchWith(results), llm: canonicalLlm({ conflict: true }) });
  assert.ok(eager.calls.length > 0);
  assert.notEqual(off.quality.gate, 'pass');
  assert.equal(on.quality.gate, off.quality.gate);
  assert.equal(on.quality.completionStatus, off.quality.completionStatus);
  assert.equal(on.quality.stopReason === 'evidence_sufficient', off.quality.stopReason === 'evidence_sufficient');
  assert.equal(on.claims.filter((claim) => claim.verdict === 'supported').length, off.claims.filter((claim) => claim.verdict === 'supported').length);
});
