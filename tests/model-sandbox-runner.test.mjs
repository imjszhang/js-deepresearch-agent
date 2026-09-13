import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSandboxPlan, planIdentity } from '../src/model-sandbox/plan.mjs';
import { runSandbox, createReplayPlan } from '../src/model-sandbox/runner.mjs';
import { inspectSandbox } from '../src/model-sandbox/artifacts.mjs';
import { acquireSandboxResource, resolveUnknownResource, hash } from '../src/model-sandbox/resource.mjs';
import { executeSandboxRequest } from 'js-deepresearch-engine';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-sandbox-runner-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function server(t, handler) {
  const srv = http.createServer(handler); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); }); return `http://127.0.0.1:${srv.address().port}/v1`;
}
function json(res, content = 'READY', usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) {
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }));
}
function options(root, baseUrl, extra = {}) {
  const plan = createSandboxPlan({ provider: 'openai-compatible', model: 'fixture-model', baseUrl, suite: 'stability', stabilityRequests: 3, ...extra });
  for (const item of plan.cases) item.stream = false;
  plan.hash = planIdentity(plan);
  return { plan, resourceDir: path.join(root, 'resources'), outputDir: path.join(root, 'run'), execute: args => executeSandboxRequest(args) };
}

test('[V25] sandbox obeys measured concurrency and never retries structure failures', async t => {
  const root = fixture(t); let active = 0, peak = 0, calls = 0;
  const base = await server(t, async (_req, res) => { calls++; active++; peak = Math.max(peak, active); await pause(30); json(res, '{"status":"invalid"}'); active--; });
  const args = options(root, base, { suite: 'concurrency', concurrencyLevels: [2], repetitions: 3 });
  for (const item of args.plan.cases) item.validation = { kind: 'enum', field: 'status', allowedValues: ['ready'] };
  args.plan.hash = planIdentity(args.plan);
  const { summary } = await runSandbox(args);
  assert.equal(calls, 6); assert.equal(peak, 2); assert.equal(summary.status, 'completed'); assert.equal(summary.origin, 'fixture');
  assert.equal(summary.structure.accepted, 0); assert.equal(summary.structure.denominator, 6); assert.equal(summary.usage.confirmedTotalTokens, 30);
  assert.equal(inspectSandbox(args.outputDir).complete, true);
});

test('[V25] unresolved execution persists across runs and explicit resolution is required', async t => {
  const root = fixture(t); let calls = 0;
  const base = await server(t, (_req, res) => { calls++; res.destroy(); });
  const args = options(root, base), first = await runSandbox(args);
  assert.equal(first.summary.status, 'outcome_unknown'); assert.equal(first.summary.unresolvedCalls, 1); assert.equal(calls, 1);
  const second = await runSandbox({ ...args, outputDir: path.join(root, 'second') });
  assert.equal(second.summary.status, 'outcome_unknown'); assert.equal(second.summary.dispatched, 0); assert.equal(calls, 1);
  assert.throws(() => resolveUnknownResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }), { code: 'SANDBOX_CONFIRMATION_REQUIRED' });
  const resolved = resolveUnknownResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId, confirmation: 'server-idle-confirmed' });
  assert.equal(resolved.resolvedCount, 1);
});

test('[V25] complete responses without usage release capacity while keeping usage unknown', async t => {
  const root = fixture(t); let calls = 0;
  const base = await server(t, (_req, res) => { calls++; json(res, 'READY', null); });
  const args = options(root, base), result = await runSandbox(args);
  assert.equal(calls, 3); assert.equal(result.summary.unresolvedCalls, 0); assert.equal(result.summary.usage.unknownUsageCalls, 3);
  assert.equal(result.summary.usage.absoluteConsumptionKnown, false);
  const lease = await acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }); lease.close();
});

test('[V25] queued cancellation sends no model request and preserves all planned cases', async t => {
  const root = fixture(t); let calls = 0;
  const base = await server(t, (_req, res) => { calls++; json(res); });
  const args = options(root, base), lease = await acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId });
  const controller = new AbortController(); const pending = runSandbox({ ...args, signal: controller.signal });
  setTimeout(() => controller.abort(), 20); const result = await pending; lease.close();
  assert.equal(result.summary.status, 'cancelled'); assert.equal(result.summary.dispatched, 0); assert.equal(result.summary.counts.skipped, 3); assert.equal(calls, 0);
});

test('[V25] process death releases the OS lock but not unresolved model execution', async t => {
  const root = fixture(t), resourceDir = path.join(root, 'resources'), resourceId = 'crash-fixture';
  const moduleUrl = new URL('../src/model-sandbox/resource.mjs', import.meta.url).href;
  const script = `import {acquireSandboxResource} from ${JSON.stringify(moduleUrl)}; const l=await acquireSandboxResource(${JSON.stringify({resourceDir,resourceId})});l.start('call-1','run-1');process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  await assert.rejects(acquireSandboxResource({ resourceDir, resourceId, queueMs: 20 }), { code: 'SANDBOX_QUEUE_TIMEOUT' });
  child.kill('SIGKILL'); await once(child, 'exit');
  await assert.rejects(acquireSandboxResource({ resourceDir, resourceId }), { code: 'SANDBOX_EXECUTION_UNRESOLVED' });
  assert.equal(resolveUnknownResource({ resourceDir, resourceId, confirmation: 'server-idle-confirmed' }).resolvedCount, 1);
});

test('[V25] exact and stream replays preserve archived hashes and production claim contracts', async t => {
  const root = fixture(t), captured = [];
  const base = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; captured.push(JSON.parse(body));
    const content = JSON.stringify({ judgments: [{ claimId: 'c1', verdict: 'supported' }] });
    if (captured.at(-1).stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    } else json(res, content);
  });
  const sessionDir = path.join(root, 'old'); fs.mkdirSync(path.join(sessionDir, 'calls'), { recursive: true });
  const body = { model: 'fixture-model', messages: [{ role: 'user', content: JSON.stringify({ claims: [{ claimId: 'c1', atomic: false, tasks: [], comparisonPassages: [] }] }) }], temperature: 0.2, reasoning_effort: 'none' };
  const file = path.join(sessionDir, 'calls/llm-185.request.json'); fs.writeFileSync(file, JSON.stringify({ kind: 'llm', callId: 'llm-185', request: { provider: 'openai-compatible', endpoint: base + '/chat/completions', body } }));
  const before = hash(fs.readFileSync(file));
  for (const mode of ['exact', 'stream']) {
    const plan = createReplayPlan({ sessionDir, callId: 'llm-185', mode, baseUrl: base });
    const result = await runSandbox({ plan, outputDir: path.join(root, mode), resourceDir: path.join(root, 'resources'), execute: args => executeSandboxRequest(args) });
    assert.equal(result.summary.status, 'completed'); assert.equal(result.summary.structure.accepted, 1);
    assert.equal(hash(fs.readFileSync(file)), before); assert.equal(fs.readFileSync(path.join(root, mode, 'plan.json'), 'utf8').includes('claimId'), false);
  }
  assert.deepEqual(captured[0], body);
  assert.deepEqual(captured[1], { ...body, stream: true, stream_options: { include_usage: true } });
});

test('[V25] plan identity and archived changes are rejected before dispatch', async t => {
  const root = fixture(t), args = options(root, 'http://127.0.0.1:1/v1'); let calls = 0;
  args.plan.cases[0].messages[0].content = 'changed';
  await assert.rejects(runSandbox({ ...args, execute: async () => { calls++; } }), { code: 'SANDBOX_PLAN_INVALID' }); assert.equal(calls, 0);
});

test('[V25] replay protects source directories and records actual endpoint variants', async t => {
  const root = fixture(t), sessionDir = path.join(root, 'old'); fs.mkdirSync(path.join(sessionDir, 'calls'), { recursive: true });
  const originalBase = 'http://127.0.0.1:1/v1', body = { model: 'fixture-model', messages: [{ role: 'user', content: 'PRIVATE_INPUT_CANARY' }], stream: true, stream_options: { include_usage: true } };
  const file = path.join(sessionDir, 'calls/llm-1.request.json'); fs.writeFileSync(file, JSON.stringify({ kind: 'llm', callId: 'llm-1', request: { provider: 'openai-compatible', endpoint: originalBase + '/chat/completions', body } }));
  const originalHash = hash(fs.readFileSync(file));
  const unchanged = createReplayPlan({ sessionDir, callId: 'llm-1', mode: 'stream', baseUrl: originalBase });
  assert.deepEqual(unchanged.cases[0].replay.overrides, []);
  await assert.rejects(runSandbox({ plan: unchanged, outputDir: path.join(root, 'new'), resourceDir: sessionDir }), { code: 'SANDBOX_OUTPUT_OVERLAP' });
  const base = await server(t, async (req, res) => {
    let sent = ''; for await (const chunk of req) sent += chunk; assert.deepEqual(JSON.parse(sent), body);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"READY"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  assert.throws(() => createReplayPlan({ sessionDir, callId: 'llm-1', mode: 'exact', baseUrl: base }), { code: 'SANDBOX_IDENTITY_MISMATCH' });
  const variant = createReplayPlan({ sessionDir, callId: 'llm-1', mode: 'stream', baseUrl: base });
  assert.deepEqual(variant.cases[0].replay.overrides, ['endpoint']);
  const result = await runSandbox({ plan: variant, outputDir: path.join(root, 'variant'), resourceDir: path.join(root, 'resources'), execute: args => executeSandboxRequest(args) });
  assert.equal(result.summary.status, 'completed'); assert.equal(hash(fs.readFileSync(file)), originalHash);
  for (const name of ['plan.json', 'summary.json', 'report.md', 'events.jsonl', 'calls/replay-1.json']) assert.equal(fs.readFileSync(path.join(result.runDir, name), 'utf8').includes('PRIVATE_INPUT_CANARY'), false);
  fs.appendFileSync(file, ' ');
  await assert.rejects(runSandbox({ plan: variant, outputDir: path.join(root, 'changed'), resourceDir: path.join(root, 'resources') }), { code: 'SANDBOX_REPLAY_CHANGED' });
});
