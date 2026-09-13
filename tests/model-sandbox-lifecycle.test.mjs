import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createSandboxPlan, planIdentity } from '../src/model-sandbox/plan.mjs';
import { runSandbox } from '../src/model-sandbox/runner.mjs';
import { acquireSandboxResource, hash } from '../src/model-sandbox/resource.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-sandbox-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createSandboxPlan({ provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1',
    suite: 'stability', stabilityRequests: 3, ...overrides });
  return { root, plan, outputDir: path.join(root, 'run'), resourceDir: path.join(root, 'resources') };
}
function complete(extra = {}) {
  return { status: 'completed', executionResolved: true, transportComplete: true, usageKnown: true,
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }, text: 'READY', finishReason: 'stop',
    metrics: { headersMs: 1, firstContentMs: 2, totalMs: 3, maxActivityGapMs: 1, contentChars: 5 }, ...extra };
}
function readCalls(dir) {
  return fs.readdirSync(path.join(dir, 'calls')).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir, 'calls', name), 'utf8')));
}
function allText(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? allText(file) : fs.readFileSync(file, 'utf8');
  }).join('\n');
}

test('[V25] durable call outcome precedes releasing its resource reservation', async t => {
  const args = fixture(t, { stabilityRequests: 1 });
  const rename = fs.renameSync, failed = deferred(); let rejectedWrite = false, pendingAtFailure;
  const target = path.join(args.outputDir, 'calls', args.plan.cases[0].id + '.json');
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && !rejectedWrite && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'completed') {
      rejectedWrite = true;
      const resourceFile = path.join(args.resourceDir, hash(args.plan.resourceId) + '.json');
      pendingAtFailure = JSON.parse(fs.readFileSync(resourceFile, 'utf8')).pending.length;
      failed.resolve();
      throw Object.assign(new Error('private-persistence-error-canary'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  const pending = runSandbox({ ...args, execute: async () => complete() }).then(value => ({ value }), error => ({ error }));
  await failed.promise;
  const outcome = await pending;
  assert.equal(rejectedWrite, true);
  assert.equal(pendingAtFailure, 1, 'The completion record must be durable before the pending marker is removed');
  assert.ok(outcome.error || outcome.value.summary.status !== 'completed');
  if (outcome.value) {
    assert.deepEqual(outcome.value.summary.resourceIsolation, { blocked: true, pendingCalls: 1 });
    assert.ok(outcome.value.summary.recommendations.some(item => item.code === 'RESOURCE_REQUIRES_RECONCILIATION'));
  }
  await assert.rejects(acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }), { code: 'SANDBOX_EXECUTION_UNRESOLVED' });
  assert.equal(allText(args.outputDir).includes('private-persistence-error-canary'), false);
});

test('[V25] persistence failure drains active workers before closing the resource lock', async t => {
  const args = fixture(t, { suite: 'concurrency', concurrencyLevels: [2], repetitions: 1 });
  assert.equal(args.plan.cases.length, 2);
  const bothActive = deferred(), releaseSecond = deferred(), failedWrite = deferred();
  const rename = fs.renameSync; let calls = 0, failed = false, settled = false;
  const target = path.join(args.outputDir, 'calls', args.plan.cases[0].id + '.json');
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && !failed && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'completed') {
      failed = true; failedWrite.resolve(); throw Object.assign(new Error('fixture disk write failure'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  const pending = runSandbox({ ...args, execute: async () => {
    const index = ++calls;
    if (index === 2) bothActive.resolve();
    await bothActive.promise;
    if (index === 2) await releaseSecond.promise;
    return complete();
  } }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await failedWrite.promise; await nextTurn(); await nextTurn();
    assert.equal(settled, false, 'One rejected worker cannot finalize a run while its sibling remains active');
    await assert.rejects(acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId, queueMs: 5 }), { code: 'SANDBOX_QUEUE_TIMEOUT' });
  } finally { releaseSecond.resolve(); await pending; }
  assert.equal(calls, 2);
  await assert.rejects(acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }), { code: 'SANDBOX_EXECUTION_UNRESOLVED' });
});

test('[V25] SIGINT cancels the active sandbox request and leaves undispatched cases untouched', async t => {
  const args = fixture(t), arrived = deferred(); let requests = 0;
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    assert.equal(JSON.parse(body).stream, true);
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'working' }, finish_reason: null }] }) + '\n\n');
    arrived.resolve();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  args.plan.baseUrl = `http://127.0.0.1:${server.address().port}/v1`; args.plan.hash = planIdentity(args.plan);
  const planFile = path.join(args.root, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(args.plan));
  const child = spawn(process.execPath, [path.join(repo, 'src/cli.mjs'), 'model-sandbox', 'run', '--plan-file', planFile,
    '--output-dir', args.outputDir, '--resource-dir', args.resourceDir, '--live', '--json'], {
    cwd: args.root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS, JDR_VERIFY_ACTIVE: '1' },
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close');
  await Promise.race([arrived.promise, closed.then(() => { throw new Error('Fixture child exited before sending a request'); })]); child.kill('SIGINT');
  const [code] = await closed;
  assert.equal(code, 130, stderr);
  const { summary } = JSON.parse(stdout);
  assert.equal(summary.status, 'cancelled'); assert.equal(summary.dispatched, 1); assert.equal(summary.counts.skipped, 2);
  assert.equal(summary.unresolvedCalls, 1); assert.equal(requests, 1);
  assert.ok(readCalls(args.outputDir).filter(row => !row.dispatched).every(row => row.status === 'skipped'));
  await assert.rejects(acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }), { code: 'SANDBOX_EXECUTION_UNRESOLVED' });
});

test('[V25] run duration deadline aborts active work without dispatching remaining cases', async t => {
  const args = fixture(t, { limits: { maxDurationMs: 30 } }); let calls = 0;
  const result = await runSandbox({ ...args, execute: async ({ signal }) => {
    calls++;
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'cancelled', executionResolved: false, transportComplete: false, usageKnown: false,
      usage: null, text: '', error: { code: 'CANCELLED', phase: 'headers' }, metrics: {} };
  } });
  assert.equal(calls, 1); assert.equal(result.summary.dispatched, 1); assert.equal(result.summary.counts.skipped, 2);
  assert.equal(result.summary.unresolvedCalls, 1);
  assert.ok(readCalls(args.outputDir).filter(row => !row.dispatched).every(row => row.reason === 'duration_limit'));
  await assert.rejects(acquireSandboxResource({ resourceDir: args.resourceDir, resourceId: args.plan.resourceId }), { code: 'SANDBOX_EXECUTION_UNRESOLVED' });
});

test('[V25] sandbox events and outcome artifacts allow only safe fields from execution', async t => {
  const args = fixture(t, { stabilityRequests: 1 }), observed = [], canary = 'private-model-body-and-credential-canary';
  const result = await runSandbox({ ...args, onEvent: event => { observed.push(event); }, execute: async ({ onEvent }) => {
    onEvent({ type: 'content', chars: 5, text: canary, reasoning: canary, headers: { authorization: canary }, contentChars: 5 });
    return complete({ text: canary, reasoning: canary, headers: { authorization: canary }, origin: 'live_observation',
      providerMetrics: { loadDurationNs: 5, secret: canary }, error: { code: 'UNTRUSTED', phase: 'provider', message: canary },
      metrics: { headersMs: 1, firstContentMs: 2, totalMs: 3, contentChars: canary.length, private: canary } });
  } });
  assert.equal(result.summary.origin, 'fixture');
  assert.equal(JSON.stringify(observed).includes(canary), false);
  assert.equal(allText(args.outputDir).includes(canary), false);
  assert.equal(result.summary.environment.cacheState, 'unverified');
  assert.equal(result.summary.environment.coldStart, 'unverified');
});

test('[V25] baseline separates buffered and streaming observations without claiming cache or cold start', async t => {
  const args = fixture(t, { suite: 'baseline', repetitions: 2 }); let calls = 0;
  const { summary } = await runSandbox({ ...args, execute: async ({ body }) => {
    calls++;
    return complete({ metrics: { headersMs: 1, firstContentMs: calls === 1 ? 1000 : body.stream ? 2 : 50,
      totalMs: calls === 1 ? 2000 : 50, contentChars: 5 },
    providerMetrics: { cachedPromptTokens: 3, loadDurationNs: 0, promptEvalDurationNs: 0 } });
  } });
  assert.equal(calls, 5); assert.equal(summary.warmupCount, 1);
  const buffered = summary.modes.find(item => item.stream === false), streaming = summary.modes.find(item => item.stream === true);
  assert.equal(buffered.metrics.firstContentMs.n, 2); assert.equal(buffered.metrics.firstContentMs.median, 50);
  assert.equal(streaming.metrics.firstContentMs.n, 2); assert.equal(streaming.metrics.firstContentMs.median, 2);
  assert.equal(summary.environment.cacheState, 'unverified'); assert.equal(summary.environment.coldStart, 'unverified');
  assert.match(summary.metricDefinitions.firstContentMs, /buffered: content visible after complete JSON response decoding/);
});
