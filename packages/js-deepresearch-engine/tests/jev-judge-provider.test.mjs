import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BudgetManager,
  FileRunRecorder,
  JevJudgeProvider,
  JudgeProviderError,
  createResearchProviders,
  defaultSettings,
  mergeSettings,
  prepareJudgeState,
} from '../src/index.mjs';

const KEY = 'ts-secret-key-value-123456';
const questions = {
  relevant: { type: 'noul', instructions: 'Does the state answer the question?' },
  kind: { type: 'choice', instructions: 'Which kind?', criteria: { article: 'An article', other: null } },
};
const goodAnswers = {
  relevant: { type: 'noul', noul: 0.7 },
  kind: { type: 'choice', choice: 'article', probabilities: { article: 0.9, other: 0.1 }, confidence: 0.85 },
};

function respond(body, status = 200) {
  return new globalThis.Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return handler(calls.at(-1), calls.length);
  };
  return { fetch, calls };
}

function judgeConfig(fetch, extra = {}) {
  return { provider: 'jev', apiKey: KEY, fetch, features: { readPriority: true }, ...extra };
}

test('Jev client sends the fixed model, bearer key and all questions in one request', async () => {
  const { fetch, calls } = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers, usage: { input_tokens: 30, output_tokens: 2 } }));
  const provider = new JevJudgeProvider({ apiKey: KEY, fetch });
  const result = await provider.judge({ state: 'body', questions });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, { model: 'jev-1.13.0', state: 'body', questions });
  assert.deepEqual(result.usage, { known: true, inputTokens: 30, outputTokens: 2, tokens: 32 });
});

test('[V26] Jev client rejects missing, extra, mistyped and out-of-range answers as structural errors', async () => {
  const cases = [
    { relevant: goodAnswers.relevant },
    { ...goodAnswers, extra: { type: 'noul', noul: 0.5 } },
    { ...goodAnswers, relevant: { type: 'choice', choice: 'article', probabilities: { article: 1 }, confidence: 1 } },
    { ...goodAnswers, relevant: { type: 'noul', noul: 1.2 } },
    { ...goodAnswers, relevant: { type: 'noul', noul: '0.5' } },
    { ...goodAnswers, kind: { ...goodAnswers.kind, choice: 'unknown' } },
    { ...goodAnswers, kind: { ...goodAnswers.kind, probabilities: { article: 0.9 } } },
    { ...goodAnswers, kind: { ...goodAnswers.kind, probabilities: { article: 1.5, other: -0.5 } } },
    { ...goodAnswers, kind: { ...goodAnswers.kind, confidence: 2 } },
  ];
  for (const answers of cases) {
    const { fetch } = fakeFetch(() => respond({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    await assert.rejects(new JevJudgeProvider({ apiKey: KEY, fetch }).judge({ state: 's', questions }),
      (error) => error instanceof JudgeProviderError && error.category === 'structure' && error.code === 'JUDGE_ANSWERS_INVALID');
  }
  const duplicate = '{"model":"jev-1.13.0","answers":{"relevant":{"type":"noul","noul":0.1},"relevant":{"type":"noul","noul":0.9}},"usage":{}}';
  const { fetch } = fakeFetch(() => respond(duplicate));
  await assert.rejects(new JevJudgeProvider({ apiKey: KEY, fetch }).judge({ state: 's', questions: { relevant: questions.relevant } }),
    (error) => error.category === 'structure');
  const substituted = fakeFetch(() => respond({ model: 'jev-latest', answers: goodAnswers, usage: {} }));
  await assert.rejects(new JevJudgeProvider({ apiKey: KEY, fetch: substituted.fetch }).judge({ state: 's', questions }),
    (error) => error.category === 'structure');
});

test('Jev score answers are checked against their own level distribution', async () => {
  const score = { level: { type: 'score', instructions: 'Rate', criteria: ['low', 'mid', 'high'] } };
  const ok = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: { level: { type: 'score', score: 1.4, probabilities: { 0: 0.2, 1: 0.3, 2: 0.5 }, confidence: 0.6 } }, usage: {} }));
  const result = await new JevJudgeProvider({ apiKey: KEY, fetch: ok.fetch }).judge({ state: 's', questions: score });
  assert.equal(result.answers.level.score, 1.4);
  const bad = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: { level: { type: 'score', score: 7, probabilities: { 0: 0.2, 1: 0.3, 2: 0.5 }, confidence: 0.6 } }, usage: {} }));
  await assert.rejects(new JevJudgeProvider({ apiKey: KEY, fetch: bad.fetch }).judge({ state: 's', questions: score }), { category: 'structure' });
});

test('[V26] missing Jev usage is reported as unknown instead of zero', async () => {
  const { fetch } = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers }));
  const result = await new JevJudgeProvider({ apiKey: KEY, fetch }).judge({ state: 's', questions });
  assert.deepEqual(result.usage, { known: false });
  const budget = new BudgetManager(mergeSettings({}));
  const providers = createResearchProviders({ judge: judgeConfig(fetch) }, { budget });
  assert.equal((await providers.judge.judge({ state: 's', questions })).status, 'completed');
  assert.equal(budget.unknown.judgeTokens, true);
  assert.equal(budget.usage.judgeTokens, undefined);
});

test('[V26] 402, 429 and 5xx degrade while other 4xx surface as client errors without provider text', async () => {
  const secretBody = 'provider says: state=CONFIDENTIAL-BODY';
  for (const status of [402, 429, 500, 503]) {
    const events = [];
    const { fetch } = fakeFetch(() => respond(secretBody, status));
    const providers = createResearchProviders({ judge: judgeConfig(fetch) }, { onEvent: (event) => events.push(event) });
    const result = await providers.judge.judge({ purpose: 'read_priority', state: 'CONFIDENTIAL-BODY', questions });
    assert.equal(result.status, 'degraded');
    assert.match(result.errorCode, /^JUDGE_/);
    assert.ok(events.some((event) => event.operation === 'judge' && event.status === 'degraded' && event.fallback === true));
    assert.ok(!JSON.stringify(events).includes('CONFIDENTIAL'));
  }
  for (const status of [400, 401, 403, 422]) {
    const { fetch } = fakeFetch(() => respond(secretBody, status));
    const providers = createResearchProviders({ judge: judgeConfig(fetch) });
    await assert.rejects(providers.judge.judge({ state: 'CONFIDENTIAL-BODY', questions }), (error) => {
      assert.equal(error.code, 'JUDGE_CLIENT_ERROR');
      assert.equal(error.category, 'client');
      assert.ok(!error.message.includes('CONFIDENTIAL') && !error.message.includes('provider says'));
      return true;
    });
  }
});

test('Jev calls respect cancellation and timeouts', async () => {
  const controller = new AbortController();
  const hanging = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const providers = createResearchProviders({ judge: judgeConfig(hanging) });
  const pending = providers.judge.judge({ state: 's', questions, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  const budget = new BudgetManager(mergeSettings({}));
  const timed = createResearchProviders({ judge: judgeConfig(hanging, { timeoutMs: 20 }) }, { budget });
  const result = await timed.judge.judge({ state: 's', questions });
  assert.equal(result.status, 'degraded');
  assert.equal(result.errorCode, 'JUDGE_TIMEOUT');
  assert.equal(budget.unknown.judgeTokens, true);
});

test('state is truncated by a character budget and the truncation is marked', () => {
  const text = prepareJudgeState('x'.repeat(50), 10);
  assert.deepEqual([text.truncated, text.originalChars, text.sentChars, text.state.length], [true, 50, 10, 10]);
  const array = prepareJudgeState(['aaaa', 'bbbb', 'cccc'], 6);
  assert.deepEqual(array.state, ['aaaa', 'bb']);
  assert.equal(array.truncated, true);
  const object = prepareJudgeState({ body: 'y'.repeat(40) }, 12);
  assert.equal(typeof object.state, 'string');
  assert.equal(object.state.length, 12);
  const pair = prepareJudgeState('ab😀', 3);
  assert.equal(pair.state, 'ab');
  assert.deepEqual(prepareJudgeState({ a: 1 }, 100).state, { a: 1 });
});

test('[V26] judge calls are recorded as calls/judge-N without the key, state text or question text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-judge-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, query: 'fixture', strategy: 'exploratory' });
  const { fetch, calls } = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers, usage: { input_tokens: 5, output_tokens: 1 } }));
  const providers = createResearchProviders({ judge: judgeConfig(fetch, { maxStateChars: 8 }) }, { recorder });
  await providers.judge.judge({ purpose: 'read_priority', state: 'PRIVATE-STATE-TEXT', questions });
  assert.equal(calls[0].body.state, 'PRIVATE-');
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'calls', 'judge-1.request.json'), 'utf8'));
  const response = JSON.parse(fs.readFileSync(path.join(dir, 'calls', 'judge-1.response.json'), 'utf8'));
  assert.equal(request.request.state.truncated, true);
  assert.equal(request.request.state.sentChars, 8);
  assert.deepEqual(request.request.questions.map((item) => [item.id, item.type]), [['relevant', 'noul'], ['kind', 'choice']]);
  assert.deepEqual(response.response.answers, goodAnswers);
  const written = fs.readdirSync(path.join(dir, 'calls')).map((name) => fs.readFileSync(path.join(dir, 'calls', name), 'utf8')).join('\n');
  for (const secret of [KEY, 'PRIVATE', 'Does the state answer']) assert.ok(!written.includes(secret));
  await providers.judge.judge({ purpose: 'read_priority', state: 'PRIVATE-STATE-TEXT', questions });
  assert.equal(calls.length, 1, 'identical judgments are served from the run cache');
});

test('[V26] judge budget caps requests and tokens separately from the LLM exploration floor', async () => {
  const settings = mergeSettings({ research: { budget: { maxJudgeRequests: 2 }, exploratory: { minLlmTokens: 1000 } } });
  const budget = new BudgetManager(settings);
  budget.executionVersion = 2;
  const { fetch, calls } = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers, usage: { input_tokens: 400, output_tokens: 600 } }));
  const providers = createResearchProviders({ judge: judgeConfig(fetch) }, { budget });
  for (const state of ['a', 'b', 'c']) await providers.judge.judge({ state, questions });
  assert.equal(calls.length, 2);
  assert.equal(budget.usage.judgeRequests, 2);
  assert.equal(budget.usage.judgeTokens, 2000);
  assert.equal(budget.usage.llmTokens, 0);
  assert.equal(budget.explorationUsed(), 0);
  assert.equal(budget.snapshot().floorStatus, 'unmet');
  assert.equal(budget.stopReason, null, 'an exhausted judge budget only degrades the judge');
  const third = await providers.judge.judge({ state: 'd', questions });
  assert.equal(third.errorCode, 'JUDGE_BUDGET_EXHAUSTED');

  const tokenBudget = new BudgetManager(mergeSettings({ research: { budget: { maxJudgeTokens: 1000 } } }));
  const tokenLimited = createResearchProviders({ judge: judgeConfig(fetch) }, { budget: tokenBudget });
  await tokenLimited.judge.judge({ state: 'e', questions });
  assert.equal((await tokenLimited.judge.judge({ state: 'f', questions })).errorCode, 'JUDGE_BUDGET_EXHAUSTED');
});

test('[V26] resumed runs reuse a recorded judge response once without a new request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-judge-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, query: 'fixture', strategy: 'exploratory' });
  const budget = new BudgetManager(mergeSettings({}));
  budget.executionVersion = 2;
  const boundary = recorder.checkpoint('exploratory-step-complete', { budget: budget.exportCheckpoint() });
  const first = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers, usage: { input_tokens: 10, output_tokens: 2 } }));
  await createResearchProviders({ judge: judgeConfig(first.fetch) }, { budget, recorder }).judge.judge({ state: 's', questions });
  const settled = budget.exportCheckpoint();
  assert.deepEqual(settled.settledJudgeCallIds, ['judge-1']);

  const resumedBudget = new BudgetManager(mergeSettings({})).restoreCheckpoint(settled);
  const reopened = FileRunRecorder.reopen(dir);
  reopened.enableRecovery(boundary.checkpointId);
  const second = fakeFetch(() => assert.fail('Recorded judge response must not dispatch'));
  const resumed = createResearchProviders({ judge: judgeConfig(second.fetch) }, { budget: resumedBudget, recorder: reopened });
  const result = await resumed.judge.judge({ state: 's', questions });
  assert.equal(result.recovered, true);
  assert.deepEqual(result.answers, goodAnswers);
  assert.equal(resumedBudget.usage.judgeTokens, 12, 'the recovered response is settled only once');
  assert.equal(second.calls.length, 0);
  const next = fakeFetch(() => respond({ model: 'jev-1.13.0', answers: goodAnswers, usage: { input_tokens: 1, output_tokens: 1 } }));
  const fresh = createResearchProviders({ judge: judgeConfig(next.fetch) }, { budget: resumedBudget, recorder: reopened });
  await fresh.judge.judge({ state: 'other', questions });
  assert.ok(fs.existsSync(path.join(dir, 'calls', 'judge-2.request.json')), 'new calls continue the recorded sequence');
});

test('default and feature-less judge configurations create no judge', () => {
  assert.equal(defaultSettings.research.providers.judge.provider, 'disabled');
  assert.equal(defaultSettings.research.providers.judge.model, 'jev-1.13.0');
  assert.equal(createResearchProviders(mergeSettings({}).research.providers).judge, null);
  assert.equal(createResearchProviders({ judge: { provider: 'jev', apiKey: KEY } }).judge, null);
  assert.equal(createResearchProviders({ judge: { provider: 'disabled', features: { readPriority: true } } }).judge, null);
  assert.throws(() => createResearchProviders({ judge: { provider: 'vercel' } }), /Unsupported judge provider/);
});

test('repeated unavailability suspends the judge for the rest of the run', async () => {
  const { fetch, calls } = fakeFetch(() => respond('down', 503));
  const providers = createResearchProviders({ judge: judgeConfig(fetch) });
  for (const state of ['a', 'b', 'c', 'd', 'e']) await providers.judge.judge({ state, questions });
  assert.equal(calls.length, 3);
  assert.equal((await providers.judge.judge({ state: 'f', questions })).errorCode, 'JUDGE_SUSPENDED');
});

test('judge identity, switches and thresholds are frozen while the key is bound from the current environment', async () => {
  const { createRunExecutionConfig, resolveRunExecutionSettings } = await import('../src/index.mjs');
  const settings = mergeSettings({ research: { providers: { judge: { provider: 'jev', apiKey: KEY,
    features: { passageOrder: true }, thresholds: { duplicateIntent: 0.95 } } } } });
  const config = createRunExecutionConfig(settings);
  const frozen = config.settings.research.providers.judge;
  assert.deepEqual([frozen.provider, frozen.model, frozen.features.passageOrder, frozen.thresholds.duplicateIntent], ['jev', 'jev-1.13.0', true, 0.95]);
  assert.ok(!JSON.stringify(config).includes(KEY));
  const current = mergeSettings({ research: { providers: { judge: { provider: 'disabled', apiKey: 'rotated-key-value',
    features: { passageOrder: false } } } } });
  const resolved = resolveRunExecutionSettings(current, { checkpoint: { executionConfig: config } });
  assert.equal(resolved.settings.research.providers.judge.provider, 'jev');
  assert.equal(resolved.settings.research.providers.judge.features.passageOrder, true);
  assert.equal(resolved.settings.research.providers.judge.apiKey, 'rotated-key-value');
});
