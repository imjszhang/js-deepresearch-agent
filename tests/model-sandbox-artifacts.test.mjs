import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxPlan, planIdentity } from '../src/model-sandbox/plan.mjs';
import { summarizeSandbox, publishSandbox, inspectSandbox, compareSandboxes, renderSandboxReport } from '../src/model-sandbox/artifacts.mjs';
import { atomicJson, hash } from '../src/model-sandbox/resource.mjs';

const build = options => createSandboxPlan({ provider: 'openai-compatible', model: 'artifact-fixture', baseUrl: 'http://localhost:11434/v1', repetitions: 1, ...options });
const context = { origin: 'fixture', elapsedMs: 300, status: 'completed' };
function rowsFor(plan) {
  return plan.cases.map((item, index) => ({ id: item.id, group: item.group, concurrency: item.concurrency, stream: item.stream, warmup: item.warmup,
    status: 'completed', dispatched: true, executionResolved: true, transportComplete: true, usageKnown: true,
    usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 }, structure: { applicable: item.validation.kind !== 'none', accepted: true },
    metrics: { headersMs: 1, firstContentMs: 5, totalMs: 100, contentChars: 20, queueMs: 0, events: 999999 },
    dispatchedOffsetMs: index * 100, endedOffsetMs: (index + 1) * 100 }));
}
function fixture(t, { plan = build(), rows = rowsFor(plan), publish = true, origin = 'fixture', resourceIsolation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'calls'));
  const run = { schemaVersion: 1, runId: 'fixture', status: 'running', origin, planHash: plan.hash, planned: plan.cases.length, ...(resourceIsolation ? { resourceIsolation } : {}) };
  atomicJson(path.join(dir, 'plan.json'), plan); atomicJson(path.join(dir, 'run.json'), run);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  for (const row of rows) atomicJson(path.join(dir, 'calls', row.id + '.json'), row);
  const summary = summarizeSandbox(plan, rows, { ...context, origin, resourceIsolation });
  if (publish) publishSandbox(dir, run, summary);
  return { dir, plan, rows, run, summary };
}
function json(dir, file) { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
const integrity = fn => assert.throws(fn, { code: 'SANDBOX_ARTIFACT_INTEGRITY' });

test('[V25] summary separates warmup, streaming modes and group concurrency while including warmup usage', () => {
  const plan = build({ repetitions: 2 }), rows = rowsFor(plan);
  rows[0].metrics.firstContentMs = 999;
  for (const row of rows.slice(1)) row.metrics.firstContentMs = row.stream ? 2 : 50;
  const summary = summarizeSandbox(plan, rows, context);
  assert.equal(summary.planned, 5); assert.equal(summary.measuredCount, 4);
  assert.equal(summary.warmup.metrics.firstContentMs.median, 999);
  assert.equal(summary.warmup.usage.confirmedTotalTokens, 10);
  assert.equal(summary.usage.confirmedTotalTokens, 50);
  assert.equal(summary.modes.find(mode => mode.stream).metrics.firstContentMs.median, 2);
  assert.equal(summary.modes.find(mode => !mode.stream).metrics.firstContentMs.median, 50);
  assert.deepEqual(summary.groupModes.map(group => [group.group, group.concurrency, group.stream, group.count]), [['baseline', 1, false, 2], ['baseline', 1, true, 2]]);
  assert.equal(summary.perCall.length, plan.cases.length);
  const report = renderSandboxReport(summary);
  assert.match(report, /Individual calls/); assert.match(report, /buffered/); assert.match(report, /stream/);
  assert.ok(report.includes('\n\n')); assert.ok(!report.includes('\\n'));
  assert.equal(summary.environment.coldStart, 'unverified'); assert.equal(summary.environment.cacheState, 'unverified');
});

test('[V25] confirmed zero, unknown usage and event counts never become fabricated token throughput', () => {
  const plan = build(), rows = rowsFor(plan);
  rows[1].usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  rows[2].usageKnown = false;
  rows[2].usage = { promptTokens: 100000, completionTokens: 100000, totalTokens: 200000 };
  const summary = summarizeSandbox(plan, rows, context);
  assert.equal(summary.usage.confirmedTotalTokens, 10);
  assert.equal(summary.usage.unknownUsageCalls, 1); assert.equal(summary.usage.absoluteConsumptionKnown, false);
  assert.equal(summary.perCall[1].usage.totalTokens, 0); assert.equal(summary.perCall[1].endToEndCompletionTokensPerSecond, 0);
  assert.equal(summary.perCall[2].usage.totalTokens, null); assert.equal(summary.perCall[2].endToEndCompletionTokensPerSecond, null);
  assert.deepEqual(summary.metrics.endToEndCompletionTokensPerSecond, { n: 1, min: 0, median: 0, max: 0 });
  assert.match(summary.rateDefinition, /dispatch-to-finish/); assert.match(summary.rateDefinition, /not a pure decode rate/);
  assert.ok(!Object.hasOwn(summary.perCall[0].metrics, 'events'));
});

test('[V25] failures, unknown calls and unsent structure cases remain in planned denominators', () => {
  const plan = build({ suite: 'structure', repetitions: 2 }), rows = rowsFor(plan);
  rows[1].structure.accepted = false;
  Object.assign(rows[2], { status: 'outcome_unknown', transportComplete: false, executionResolved: false, usageKnown: false });
  Object.assign(rows[3], { status: 'skipped', dispatched: false, transportComplete: false, usageKnown: false, structure: { applicable: true, accepted: null } });
  Object.assign(rows[4], { status: 'cancelled', transportComplete: false, usageKnown: false });
  Object.assign(rows[5], { status: 'failed', transportComplete: false, usageKnown: false });
  const summary = summarizeSandbox(plan, rows, { ...context, status: 'outcome_unknown' });
  assert.deepEqual(summary.transport, { numerator: 2, denominator: 6, dispatchedDenominator: 5 });
  assert.equal(summary.structure.denominator, 6); assert.equal(summary.structure.dispatchedDenominator, 5);
  assert.equal(summary.metrics.totalMs.n, 2); // Complete transport with failed structure remains a performance sample.
  assert.equal(summary.counts.skipped, 1); assert.equal(summary.counts.cancelled, 1);
  assert.equal(summary.counts.outcome_unknown, 1); assert.equal(summary.counts.failed, 1);
  assert.equal(summary.unresolvedCalls, 1);
  const partial = summarizeSandbox(plan, rows.slice(0, 1), context);
  assert.equal(partial.planned, 6); assert.equal(partial.counts.not_recorded, 5); assert.equal(partial.structure.denominator, 6);
});

test('[V25] provider duration metrics remain separately labeled nanoseconds without inferring environment state', () => {
  const plan = build(), rows = rowsFor(plan);
  rows[1].providerMetrics = { loadDurationNs: 123, totalDurationNs: 456, private: 'not exposed' };
  const summary = summarizeSandbox(plan, rows, context);
  assert.equal(summary.providerMetrics.loadDurationNs.median, 123);
  assert.equal(summary.perCall[1].providerMetrics.totalDurationNs, 456);
  assert.ok(!JSON.stringify(summary).includes('not exposed'));
  assert.equal(summary.environment.cacheState, 'unverified'); assert.equal(summary.environment.serverQueueTime, 'unavailable');
});

test('[V25] publish and inspect verify a complete plan-derived manifest including every planned call', t => {
  const { dir, summary, plan } = fixture(t);
  assert.deepEqual(inspectSandbox(dir).summary, summary);
  assert.equal(json(dir, 'manifest.json').files.filter(entry => entry.file.startsWith('calls/')).length, plan.cases.length);
  fs.appendFileSync(path.join(dir, 'calls', plan.cases[0].id + '.json'), ' ');
  integrity(() => inspectSandbox(dir));
});

test('[V25] removing manifest call entries cannot conceal omitted, deleted or unlisted outcomes', t => {
  for (const removeFile of [false, true]) {
    const { dir, plan } = fixture(t), manifest = json(dir, 'manifest.json'), target = 'calls/' + plan.cases[0].id + '.json';
    manifest.files = manifest.files.filter(entry => entry.file !== target);
    atomicJson(path.join(dir, 'manifest.json'), manifest);
    if (removeFile) fs.unlinkSync(path.join(dir, target));
    integrity(() => inspectSandbox(dir));
  }
  const { dir } = fixture(t);
  atomicJson(path.join(dir, 'calls', 'extra.json'), {});
  integrity(() => inspectSandbox(dir));
});

test('[V25] summary changes cannot be legitimized just by updating its manifest hash', t => {
  const { dir } = fixture(t), summary = json(dir, 'summary.json'), manifest = json(dir, 'manifest.json');
  summary.usage.confirmedTotalTokens = 0;
  atomicJson(path.join(dir, 'summary.json'), summary);
  manifest.files.find(entry => entry.file === 'summary.json').hash = hash(fs.readFileSync(path.join(dir, 'summary.json')));
  atomicJson(path.join(dir, 'manifest.json'), manifest);
  integrity(() => inspectSandbox(dir));
});

test('[V25] publish rejects missing planned outcomes and inspect rejects symbolic-link substitution', t => {
  const plan = build();
  const missing = fixture(t, { plan, rows: rowsFor(plan).slice(0, 1), publish: false });
  integrity(() => publishSandbox(missing.dir, missing.run, missing.summary));
  const { dir } = fixture(t), file = path.join(dir, 'summary.json'), copy = path.join(dir, 'copy.json');
  fs.renameSync(file, copy); fs.symlinkSync(copy, file);
  integrity(() => inspectSandbox(dir));
});

test('[V25] running inspection returns only safe status counters without claiming process liveness', t => {
  const plan = build(), rows = rowsFor(plan).slice(0, 1);
  Object.assign(rows[0], { status: 'outcome_unknown', executionResolved: false, text: 'sensitive content', reasoning: 'sensitive reasoning' });
  const { dir } = fixture(t, { plan, rows, publish: false });
  const result = inspectSandbox(dir);
  assert.equal(result.complete, false); assert.equal(result.requiresProcessCheck, true);
  assert.equal(result.planned, 3); assert.equal(result.recorded, 1); assert.equal(result.notYetRecorded, 2); assert.equal(result.unresolvedCalls, 1);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('[V25] comparison exposes changed parameters and input hashes instead of ranking different plans', t => {
  const a = fixture(t), same = fixture(t, { plan: a.plan });
  assert.equal(compareSandboxes(a.dir, same.dir).comparable, true);
  const changed = build({ temperature: 0.5 });
  changed.cases[1].messages[0].content = 'PRIVATE INPUT CONTENT'; changed.hash = planIdentity(changed);
  const b = fixture(t, { plan: changed }), comparison = compareSandboxes(a.dir, b.dir);
  assert.equal(comparison.comparable, false); assert.equal(comparison.comparisonKind, 'different-plans');
  assert.ok(comparison.parameterDifferences.some(item => item.field === 'cases.1.messagesHash'));
  assert.ok(comparison.parameterDifferences.some(item => item.field === 'cases.1.temperature'));
  assert.ok(!JSON.stringify(comparison).includes('PRIVATE INPUT CONTENT'));
  const otherOrigin = fixture(t, { plan: a.plan, origin: 'live_observation' });
  assert.equal(compareSandboxes(a.dir, otherOrigin.dir).comparisonKind, 'different-origins');
  const running = fixture(t, { publish: false });
  assert.throws(() => compareSandboxes(a.dir, running.dir), { code: 'SANDBOX_COMPARE_INCOMPLETE' });
});

test('[V25] resource isolation is persisted from the run and cannot be erased in the summary', t => {
  const isolation = { blocked: true, pendingCalls: null };
  const { dir, summary } = fixture(t, { resourceIsolation: isolation });
  assert.deepEqual(inspectSandbox(dir).summary.resourceIsolation, isolation);
  assert.ok(summary.recommendations.some(item => item.code === 'RESOURCE_REQUIRES_RECONCILIATION'));
  const manifest = json(dir, 'manifest.json'), run = json(dir, 'run.json');
  run.resourceIsolation = { blocked: false, pendingCalls: 0 };
  atomicJson(path.join(dir, 'run.json'), run);
  manifest.files.find(entry => entry.file === 'run.json').hash = hash(fs.readFileSync(path.join(dir, 'run.json')));
  atomicJson(path.join(dir, 'manifest.json'), manifest);
  integrity(() => inspectSandbox(dir));
});

test('[V25] complete artifact names support all safe plan identifiers including dots and colons', t => {
  const plan = build(); plan.cases[0].id = 'warmup.phase:1'; plan.hash = planIdentity(plan);
  const { dir } = fixture(t, { plan });
  assert.equal(inspectSandbox(dir).complete, true);
});
