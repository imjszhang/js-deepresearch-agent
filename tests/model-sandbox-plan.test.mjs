import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxPlan, validateSandboxPlan, planIdentity } from '../src/model-sandbox/plan.mjs';

const base = { provider: 'openai-compatible', model: 'local-fixture', baseUrl: 'http://127.0.0.1:11434/v1', createdAt: '2026-09-12T00:00:00.000Z' };
const build = options => createSandboxPlan({ ...base, ...options });
const invalid = fn => assert.throws(fn, { code: 'SANDBOX_PLAN_INVALID' });
function changed(plan, modify) {
  const value = globalThis.structuredClone(plan);
  modify(value);
  value.hash = planIdentity(value);
  return value;
}

test('baseline freezes one warmup and three parameter-matched buffered/streaming pairs', () => {
  const plan = build();
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.cases.length, 7);
  assert.equal(plan.limits.maxRequests, 7);
  assert.equal(plan.cases.filter(item => item.warmup).length, 1);
  assert.equal(plan.cases[0].warmup, true);
  assert.equal(plan.seed, '1');
  assert.match(plan.resourceId, /^endpoint-[a-f0-9]{64}$/);
  assert.deepEqual(plan.timeouts, { queueMs: 300000, headersMs: 900000, firstEventMs: 900000, idleMs: 120000, totalMs: 1800000 });
  assert.equal(plan.limits.maxDurationMs, 7200000);
  for (let index = 1; index < plan.cases.length; index += 2) {
    const left = plan.cases[index];
    const right = plan.cases[index + 1];
    assert.equal(left.stream, false);
    assert.equal(right.stream, true);
    assert.equal(left.maxTokens, 0);
    assert.equal(right.maxTokens, 0);
    const comparable = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'stream'].includes(key)));
    assert.deepEqual(comparable(left), comparable(right));
  }
  assert.equal(validateSandboxPlan(plan), plan);
});

test('identities ignore object key order and creation time but preserve executable changes', () => {
  const plan = build();
  const reordered = JSON.parse(JSON.stringify(plan));
  reordered.timeouts = Object.fromEntries(Object.entries(reordered.timeouts).reverse());
  reordered.createdAt = '2026-09-13T00:00:00.000Z';
  reordered.hash = 'a'.repeat(64);
  assert.equal(planIdentity(reordered), plan.hash);
  reordered.cases[1].stream = true;
  assert.notEqual(planIdentity(reordered), plan.hash);
  const corrupted = globalThis.structuredClone(plan);
  corrupted.model = 'changed-model';
  invalid(() => validateSandboxPlan(corrupted));
});

test('seeded input fixtures have exact declared character counts and repeat deterministically', () => {
  const a = build({ suite: 'input', inputChars: [64, 256], repetitions: 2, seed: 7 });
  const b = build({ suite: 'input', inputChars: [64, 256], repetitions: 2, seed: '7' });
  const c = build({ suite: 'input', inputChars: [64, 256], repetitions: 2, seed: '8' });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.equal(a.cases[0].messages[0].content.split('\n')[1].length, 64);
  assert.equal(a.cases[2].messages[0].content.split('\n')[1].length, 256);
  assert.equal(a.cases[0].messages[0].content, a.cases[1].messages[0].content);
  assert.match(a.cases[0].messages[0].content, /not a token count/);
  const defaults = build({ suite: 'input', repetitions: 1 });
  assert.deepEqual(defaults.cases.map(item => item.group), ['input-2048', 'input-8192', 'input-32768', 'input-65536']);
});

test('all fixed suites have bounded cases and stable group concurrency', () => {
  const expected = { baseline: 7, input: 12, output: 9, concurrency: 9, structure: 9, cancellation: 3, stability: 10 };
  for (const [suite, count] of Object.entries(expected)) {
    const plan = build({ suite });
    assert.equal(plan.cases.length, count, suite);
    assert.equal(plan.limits.maxRequests, count, suite);
    assert.equal(validateSandboxPlan(plan), plan);
  }
  const concurrency = build({ suite: 'concurrency', concurrencyLevels: [1, 2, 4], repetitions: 2 });
  assert.deepEqual(concurrency.cases.map(item => item.concurrency), [1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual(build({ suite: 'output', outputTokens: [64, 1024], repetitions: 1 }).cases.map(item => item.maxTokens), [64, 1024]);
  assert.equal(build({ suite: 'stability', stabilityRequests: 4 }).cases.length, 4);
});

test('structure suite uses frozen deterministic oracle specifications', () => {
  const plan = build({ suite: 'structure', repetitions: 1 });
  assert.deepEqual(plan.cases.map(item => item.validation), [
    { kind: 'json-object' },
    { kind: 'exact-ids', field: 'items', idField: 'id', expectedIds: ['item-a', 'item-b', 'item-c'] },
    { kind: 'enum', field: 'status', allowedValues: ['ready', 'blocked', 'unknown'] },
  ]);
  invalid(() => validateSandboxPlan(changed(plan, value => value.cases[1].validation.expectedIds.push('item-a'))));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[2].validation.allowedValues = []; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[0].validation.kind = 'model-judge'; })));
});

test('endpoint normalization determines a stable resource identity without credential-bearing URLs', () => {
  const a = build({ baseUrl: 'HTTP://LOCALHOST:11434/v1/' });
  const b = build({ baseUrl: 'http://localhost:11434/v1' });
  assert.equal(a.baseUrl, b.baseUrl);
  assert.equal(a.resourceId, b.resourceId);
  assert.equal(build({ resourceId: 'shared-gpu' }).resourceId, 'shared-gpu');
  for (const baseUrl of ['file:///tmp/model', 'http://user:secret@localhost:80', 'http://localhost?api_key=secret', 'http://localhost#secret']) invalid(() => build({ baseUrl }));
  invalid(() => build({ resourceId: '../escape' }));
  invalid(() => validateSandboxPlan(changed(a, value => { value.baseUrl += '/'; })));
});

test('request and timing limits reject underbudget or unbounded campaigns', () => {
  invalid(() => build({ limits: { maxRequests: 6 } }));
  invalid(() => build({ limits: { maxRequests: 10001 } }));
  invalid(() => build({ repetitions: 10000 }));
  invalid(() => build({ limits: { maxDurationMs: 0 } }));
  invalid(() => build({ limits: { maxResponseBytes: -1 } }));
  invalid(() => build({ timeouts: { idleMs: 0 } }));
  invalid(() => build({ timeouts: { typoMs: 100 } }));
  invalid(() => build({ timeouts: null }));
  invalid(() => build({ limits: null }));
  assert.equal(build({ limits: { maxRequests: 20 }, maxTokens: 0 }).limits.maxRequests, 20);
  const small = build({ timeouts: { totalMs: 5000, idleMs: 100 }, limits: { maxDurationMs: 10000 } });
  assert.equal(small.timeouts.totalMs, 5000);
});

test('cancellation is explicit and precedes the execution total deadline', () => {
  const plan = build({ suite: 'cancellation', cancelAfterMs: 250 });
  assert.ok(plan.cases.every(item => item.cancelAfterMs === 250));
  invalid(() => build({ suite: 'cancellation', cancelAfterMs: 0 }));
  invalid(() => build({ suite: 'cancellation', cancelAfterMs: 2000, timeouts: { totalMs: 2000 } }));
});

test('strict validation rejects duplicate ids, noncontiguous groups, inconsistent concurrency and malformed messages', () => {
  const plan = build();
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[1].id = value.cases[0].id; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[1].group = 'other'; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[1].concurrency = 2; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[0].messages = []; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[0].messages[0].role = 'tool'; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[0].messages[0].extra = 'ignored'; })));
  invalid(() => validateSandboxPlan(changed(plan, value => { value.cases[0].stream = 'true'; })));
});

test('strict schemas reject hidden defaults, malformed seeds and unsupported configuration', () => {
  invalid(() => build({ ignoredFlag: true }));
  invalid(() => build({ suite: 'nonexistent' }));
  invalid(() => build({ provider: 'unknown' }));
  invalid(() => build({ seed: {} }));
  invalid(() => build({ seed: '' }));
  invalid(() => build({ createdAt: '2026-09-12' }));
  invalid(() => build({ temperature: '0' }));
  invalid(() => build({ maxTokens: -1 }));
  invalid(() => build({ suite: 'input', inputChars: [1000001] }));
  invalid(() => build({ suite: 'input', inputChars: [10, 10] }));
  invalid(() => build({ suite: 'concurrency', concurrencyLevels: [0] }));
  invalid(() => build({ suite: 'output', outputTokens: [] }));
});

test('identity rejects non-JSON and cyclic structures rather than hashing a lossy projection', () => {
  invalid(() => planIdentity({ schemaVersion: 1, unsupported: undefined }));
  invalid(() => planIdentity({ value: Infinity }));
  const cycle = {};
  cycle.cycle = cycle;
  invalid(() => planIdentity(cycle));
});

function replayPlan(mode = 'exact') {
  const plan = build({ repetitions: 1 });
  plan.suite = 'replay';
  plan.cases = [{ ...plan.cases[1], messages: [], stream: mode === 'stream', replay: {
    sessionDir: '/tmp/synthetic-replay', callId: 'llm-185', mode, requestFileHash: 'a'.repeat(64), originalBodyHash: 'b'.repeat(64),
    effectiveBodyHash: mode === 'exact' ? 'b'.repeat(64) : 'c'.repeat(64), provider: plan.provider, model: plan.model,
    endpointHash: 'd'.repeat(64), overrides: mode === 'exact' ? [] : ['stream', 'stream_options.include_usage'],
  } }];
  plan.hash = planIdentity(plan);
  return plan;
}

test('replay plan supports frozen metadata without copying private request content', () => {
  for (const mode of ['exact', 'stream']) {
    const plan = replayPlan(mode);
    assert.equal(validateSandboxPlan(plan), plan);
    assert.deepEqual(plan.cases[0].messages, []);
  }
  invalid(() => build({ suite: 'replay' }));
  invalid(() => validateSandboxPlan(changed(replayPlan(), value => { value.cases[0].messages = [{ role: 'user', content: 'private' }]; })));
  invalid(() => validateSandboxPlan(changed(replayPlan(), value => { value.cases[0].replay.originalBodyHash = 'c'.repeat(64); })));
  invalid(() => validateSandboxPlan(changed(replayPlan(), value => { value.cases[0].replay.model = 'drift'; })));
  invalid(() => validateSandboxPlan(changed(replayPlan(), value => { value.cases[0].replay.sessionDir = './relative'; })));
  invalid(() => validateSandboxPlan(changed(replayPlan('stream'), value => { value.cases[0].replay.overrides = ['messages']; })));
  invalid(() => validateSandboxPlan(changed(replayPlan('stream'), value => { value.cases[0].stream = false; })));
});
