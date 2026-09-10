import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCampaign, runCampaign, reconcileRun, spawnRun } from '../scripts/benchmark/quality/campaign.mjs';
import { loadSuite, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { acquireSessionLock } from '../src/session-lock.mjs';

const temp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-campaign-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
test('provider failure after session creation pauses the batch instead of dispatching seven more runs', async t => {
  const dir = temp(t), suite = loadSuite('benchmarks/research-quality/v1/suite.json');
  const c = createCampaign({ suite, directory: dir, identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  let calls = 0;
  const result = await runCampaign({ file: path.join(dir, 'campaign.json'), currentIdentity: {}, execute: async () => {
    calls++;
    const session = path.join(c.runs[0].directory, 'exploratory', '2026-01-01_000000');
    writeJson(path.join(session, 'run.json'), { status: 'failed' });
    writeJson(path.join(session, 'failure.json'), { error: { code: 'SEARCH_PROVIDER_UNAVAILABLE' } });
    return { code: 1 };
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'environment_paused');
  assert.equal(result.runs.filter(r => r.status === 'queued').length, 7);
  await runCampaign({ file: path.join(dir, 'campaign.json'), currentIdentity: {}, execute: () => assert.fail('paused batch cannot restart itself') });
});

test('OS lock prevents a concurrent campaign writer and does not rely on deleting a lock file', async t => {
  const dir = temp(t), suite = loadSuite('benchmarks/research-quality/v1/suite.json');
  createCampaign({ suite, directory: dir, identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  const release = acquireSessionLock(dir);
  try { await assert.rejects(runCampaign({ file: path.join(dir, 'campaign.json'), currentIdentity: {} }), { code: 'SESSION_BUSY' }); }
  finally { release(); }
  const next = acquireSessionLock(dir); next();
  assert.ok(fs.existsSync(path.join(dir, '.writer.sqlite')));
});

test('PID reuse does not mean original run is alive, and unknown identity never permits duplicate dispatch', t => {
  const directory = temp(t);
  assert.equal(reconcileRun({ directory, pid: 1, processIdentity: 'original' }, () => ({ alive: true, identity: 'new-owner' })), 'interrupted');
  assert.equal(reconcileRun({ directory, pid: 1, processIdentity: 'original' }, () => ({ alive: true, identity: null })), 'unknown');
  assert.equal(reconcileRun({ directory, pid: 1, processIdentity: 'original' }, () => ({ alive: true, identity: 'original' })), 'running');
});

test('onStarted storage failure terminates its child and returns the storage error after close', async t => {
  const directory = temp(t), child = new EventEmitter(); child.pid = 999;
  const killed = [];
  const outcome = await spawnRun({ directory, args: [], cwd: directory, timeoutMs: 1000,
    spawnProcess: () => child, onStarted: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    killProcess: (process, signal) => { assert.equal(process, child); killed.push(signal); queueMicrotask(() => child.emit('close', 130, signal)); },
  });
  assert.deepEqual(killed, ['SIGINT']); assert.equal(outcome.failureCode, 'ENOSPC'); assert.equal(outcome.code, 130);
});
