import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxPlan, validateSandboxPlan, planIdentity, readSandboxPlan, MAX_SANDBOX_PLAN_BYTES } from '../src/model-sandbox/plan.mjs';

const options = { provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1' };
const invalid = (action) => assert.throws(action, error => error.code === 'SANDBOX_PLAN_INVALID');

test('sandbox plan bounds all Node timer values before generation and after loading', () => {
  for (const key of ['queueMs', 'headersMs', 'firstEventMs', 'idleMs', 'totalMs']) {
    for (const value of [0, -1, 2 ** 31, 1.5]) {
      invalid(() => createSandboxPlan({ ...options, timeouts: { [key]: value } }));
      const plan = createSandboxPlan(options); plan.timeouts[key] = value; plan.hash = planIdentity(plan);
      invalid(() => validateSandboxPlan(plan));
    }
  }
  invalid(() => createSandboxPlan({ ...options, limits: { maxDurationMs: 2 ** 31 } }));
  invalid(() => createSandboxPlan({ ...options, suite: 'cancellation', cancelAfterMs: 2 ** 31 }));
  const plan = createSandboxPlan({ ...options, limits: { maxDurationMs: 2 ** 31 - 1 }, timeouts: { totalMs: 2 ** 31 - 1 } });
  assert.equal(validateSandboxPlan(plan), plan);
});

test('sandbox generated inputs are bounded across repetitions, not only one message', () => {
  invalid(() => createSandboxPlan({ ...options, suite: 'input', inputChars: [1_000_000], repetitions: 1000 }));
  const plan = createSandboxPlan(options);
  plan.cases = Array.from({ length: 33 }, (_, i) => ({ ...plan.cases[0], id: `large-${i}`, messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }] }));
  plan.limits.maxRequests = plan.cases.length;
  // Verify before hashing as an untrusted loaded plan need not carry a valid hash.
  invalid(() => validateSandboxPlan(plan));
});

test('sandbox plan identity bounds representation size and nesting, supports shared fixture values', () => {
  assert.equal(createSandboxPlan({ ...options, suite: 'structure' }).cases.length, 9);
  const node = {}; node.self = node;
  invalid(() => planIdentity(node));
  let nested = {}; for (let i = 0; i < 40; i++) nested = { child: nested };
  invalid(() => planIdentity(nested));
  const repeated = '\u0000'.repeat(1_000_000);
  invalid(() => planIdentity({ data: Array(12).fill(repeated) }));
});

test('sandbox plan file reader refuses oversized sparse files before allocation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-plan-limit-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'plan.json');
  const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, MAX_SANDBOX_PLAN_BYTES + 1); fs.closeSync(fd);
  invalid(() => readSandboxPlan(file));
  const plan = createSandboxPlan(options); fs.writeFileSync(file, JSON.stringify(plan));
  assert.deepEqual(readSandboxPlan(file), plan);
  fs.writeFileSync(file, '{broken SECRET'); invalid(() => readSandboxPlan(file));
  assert.throws(() => readSandboxPlan(path.join(root, 'SECRET_missing')), error => error.code === 'SANDBOX_PLAN_INVALID' && !error.message.includes('SECRET'));
});

test('sandbox response byte limit is finite and checked before requests', () => {
  invalid(() => createSandboxPlan({ ...options, limits: { maxResponseBytes: 256 * 1024 * 1024 + 1 } }));
});
