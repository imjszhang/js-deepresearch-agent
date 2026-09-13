import fs from 'node:fs';
import path from 'node:path';
import { hash, atomicJson, sandboxError } from './resource.mjs';
import { validateSandboxPlan } from './plan.mjs';

const METRICS = ['headersMs', 'firstBodyMs', 'firstEventMs', 'firstReasoningMs', 'firstContentMs', 'lastContentMs', 'lastActivityMs', 'totalMs', 'maxActivityGapMs', 'queueMs', 'contentChars'];
const PROVIDER_METRICS = ['totalDurationNs', 'loadDurationNs', 'promptEvalDurationNs', 'evalDurationNs'];
const STATUSES = ['completed', 'failed', 'cancelled', 'outcome_unknown', 'skipped', 'not_recorded'];
const REQUIRED_FILES = ['plan.json', 'run.json', 'events.jsonl', 'summary.json', 'report.md'];
const RATE_DEFINITION = 'provider completionTokens / (dispatch-to-finish totalMs / 1000); includes response wait, generation and transport, excludes local queue; not a pure decode rate';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = value => Number.isSafeInteger(value) && value >= 0;

export function distribution(values) {
  const xs = values.filter(finite).sort((a, b) => a - b), n = xs.length;
  return { n, min: n ? xs[0] : null, median: n ? (xs[Math.floor((n - 1) / 2)] + xs[Math.floor(n / 2)]) / 2 : null, max: n ? xs[n - 1] : null };
}
function knownUsage(row, key) {
  return row.dispatched && row.usageKnown === true && tokens(row.usage?.[key]) ? row.usage[key] : null;
}
function sumKnown(rows, key) { return rows.reduce((sum, row) => sum + (knownUsage(row, key) ?? 0), 0); }
function completionRate(row) {
  const count = knownUsage(row, 'completionTokens'), ms = row.metrics?.totalMs;
  return row.transportComplete && count !== null && finite(ms) && ms > 0 ? count * 1000 / ms : null;
}
function safeMetrics(row) { return Object.fromEntries(METRICS.map(key => [key, finite(row.metrics?.[key]) ? row.metrics[key] : null])); }
function safeProviderMetrics(row) { return Object.fromEntries(PROVIDER_METRICS.map(key => [key, tokens(row.providerMetrics?.[key]) ? row.providerMetrics[key] : null])); }
function sampleSummary(rows) {
  const sent = rows.filter(row => row.dispatched), completed = sent.filter(row => row.transportComplete);
  const checked = rows.filter(row => row.structure?.applicable);
  const metrics = Object.fromEntries(METRICS.map(key => [key, distribution(completed.map(row => row.metrics?.[key]))]));
  metrics.endToEndCompletionTokensPerSecond = distribution(completed.map(completionRate));
  const counts = Object.fromEntries(STATUSES.map(key => [key, rows.filter(row => row.status === key).length]));
  return {
    planned: rows.length, dispatched: sent.length, notDispatched: rows.length - sent.length, counts,
    unresolvedCalls: sent.filter(row => !row.executionResolved).length,
    transport: { numerator: completed.length, denominator: rows.length, dispatchedDenominator: sent.length },
    structure: { accepted: checked.filter(row => row.structure.accepted === true).length, denominator: checked.length,
      dispatchedDenominator: checked.filter(row => row.dispatched).length,
      notEvaluated: checked.filter(row => row.structure.accepted === null || row.structure.accepted === undefined).length },
    usage: { confirmedTotalTokens: sumKnown(rows, 'totalTokens'), confirmedPromptTokens: sumKnown(rows, 'promptTokens'),
      confirmedCompletionTokens: sumKnown(rows, 'completionTokens'), unknownUsageCalls: sent.filter(row => knownUsage(row, 'totalTokens') === null).length,
      unknownPromptUsageCalls: sent.filter(row => knownUsage(row, 'promptTokens') === null).length,
      unknownCompletionUsageCalls: sent.filter(row => knownUsage(row, 'completionTokens') === null).length,
      absoluteConsumptionKnown: sent.every(row => knownUsage(row, 'totalTokens') !== null) },
    metrics, providerMetrics: Object.fromEntries(PROVIDER_METRICS.map(key => [key, distribution(completed.map(row => row.providerMetrics?.[key]))])),
  };
}
function orderedRows(plan, rows) {
  const byId = new Map(), expected = new Set(plan.cases.map(item => item.id));
  for (const row of rows) {
    if (!expected.has(row.id) || byId.has(row.id)) throw sandboxError('SANDBOX_SUMMARY_INVALID');
    byId.set(row.id, row);
  }
  return plan.cases.map(item => {
    const row = byId.get(item.id) || { status: 'not_recorded', dispatched: false, executionResolved: true, transportComplete: false,
      usageKnown: false, structure: { applicable: item.validation.kind !== 'none' || Boolean(item.replay), accepted: null }, metrics: {} };
    return { ...row, id: item.id, group: item.group, concurrency: item.concurrency, warmup: item.warmup, stream: item.stream,
      structure: { ...row.structure, applicable: item.replay ? Boolean(row.structure?.applicable) : item.validation.kind !== 'none' } };
  });
}
function groupSummary(group, rows) {
  const summary = sampleSummary(rows), sent = rows.filter(row => row.dispatched);
  const hasDuration = sent.length > 0 && sent.every(row => finite(row.endedOffsetMs) && finite(row.dispatchedOffsetMs) && row.endedOffsetMs >= row.dispatchedOffsetMs);
  const durationMs = hasDuration ? Math.max(...sent.map(row => row.endedOffsetMs)) - Math.min(...sent.map(row => row.dispatchedOffsetMs)) : null;
  return { group, concurrency: rows[0]?.concurrency ?? null, stream: rows.every(row => row.stream === rows[0]?.stream) ? rows[0]?.stream : null,
    count: rows.length, completed: summary.transport.numerator, durationMs, firstContentMs: summary.metrics.firstContentMs,
    completionTokens: summary.usage.confirmedCompletionTokens, unknownUsageCalls: summary.usage.unknownUsageCalls,
    requestsPerSecond: durationMs > 0 ? summary.transport.numerator * 1000 / durationMs : null,
    requestsPerSecondDefinition: 'transport-complete requests / dispatch span of all sent requests, including failures', ...summary };
}
function configuration(plan) {
  return { provider: plan.provider, model: plan.model, baseUrl: plan.baseUrl, resourceId: plan.resourceId, suite: plan.suite, seed: plan.seed,
    timeouts: plan.timeouts, limits: plan.limits, cases: plan.cases.map(item => ({ id: item.id, group: item.group, concurrency: item.concurrency,
      warmup: item.warmup, stream: item.stream, maxTokens: item.maxTokens ?? null, temperature: item.temperature,
      cancelAfterMs: item.cancelAfterMs ?? null, messagesHash: hash(item.messages), validation: item.validation,
      replay: item.replay ? { mode: item.replay.mode, originalBodyHash: item.replay.originalBodyHash, effectiveBodyHash: item.replay.effectiveBodyHash,
        endpointHash: item.replay.endpointHash, overrides: item.replay.overrides } : null })) };
}
export function summarizeSandbox(plan, rows, { origin, elapsedMs, status, resourceQueueMs = 0, resourceIsolation = { blocked: false, pendingCalls: 0 } }) {
  if (!resourceIsolation || typeof resourceIsolation.blocked !== 'boolean' || (resourceIsolation.pendingCalls !== null && !tokens(resourceIsolation.pendingCalls))) throw sandboxError('SANDBOX_SUMMARY_INVALID');
  rows = orderedRows(plan, rows);
  const measured = rows.filter(row => !row.warmup), warmup = rows.filter(row => row.warmup);
  const main = sampleSummary(measured), all = sampleSummary(rows);
  const groups = [...new Set(measured.map(row => row.group))].map(group => groupSummary(group, measured.filter(row => row.group === group)));
  const modes = [false, true].map(stream => ({ stream, ...sampleSummary(measured.filter(row => row.stream === stream)) }));
  const groupModes = groups.flatMap(group => [false, true].map(stream => {
    const records = measured.filter(row => row.group === group.group && row.stream === stream);
    return records.length ? { ...groupSummary(group.group, records), stream } : null;
  }).filter(Boolean));
  return { schemaVersion: 1, planHash: plan.hash, provider: plan.provider, model: plan.model, suite: plan.suite, origin,
    status, elapsedMs, resourceQueueMs, resourceIsolation: { blocked: resourceIsolation.blocked, pendingCalls: resourceIsolation.pendingCalls }, planned: plan.cases.length, warmupCount: warmup.length,
    measuredCount: measured.length, dispatched: all.dispatched, counts: main.counts, allCounts: all.counts,
    unresolvedCalls: all.unresolvedCalls, transport: main.transport, structure: main.structure,
    usage: { ...all.usage, includesWarmup: true }, metrics: main.metrics, providerMetrics: main.providerMetrics, groups, modes, groupModes,
    measured: main, warmup: sampleSummary(warmup), configuration: configuration(plan),
    perCall: rows.map(row => ({ id: row.id, group: row.group, concurrency: row.concurrency, warmup: row.warmup, stream: row.stream,
      status: row.status, dispatched: Boolean(row.dispatched), transportComplete: Boolean(row.transportComplete), executionResolved: Boolean(row.executionResolved),
      usageKnown: knownUsage(row, 'totalTokens') !== null,
      usage: { promptTokens: knownUsage(row, 'promptTokens'), completionTokens: knownUsage(row, 'completionTokens'), totalTokens: knownUsage(row, 'totalTokens') },
      structure: { applicable: Boolean(row.structure?.applicable), accepted: row.structure?.accepted === true ? true : row.structure?.accepted === false ? false : null },
      metrics: safeMetrics(row), providerMetrics: safeProviderMetrics(row), endToEndCompletionTokensPerSecond: completionRate(row) })),
    rateDefinition: RATE_DEFINITION,
    metricDefinitions: { firstContentMs: 'stream: first nonempty content delta visible to client; buffered: content visible after complete JSON response decoding; neither isolates server queue or prefill',
      totalMs: 'dispatch-to-finish, excluding local queue', endToEndCompletionTokensPerSecond: RATE_DEFINITION },
    environment: { externalLoad: 'uncontrolled', serverQueueTime: 'unavailable', coldStart: 'unverified', cacheState: 'unverified' },
    recommendations: [...recommendations(groupModes, rows), ...(resourceIsolation.blocked ? [{ code: 'RESOURCE_REQUIRES_RECONCILIATION' }] : [])],
    performanceSampleSelection: 'transport-complete, non-warmup; structure failures retained; failure/skipped/unknown counts remain in planned denominators' };
}
function recommendations(groups, rows) {
  const recommendations = [];
  if (rows.some(row => row.dispatched && !row.executionResolved)) recommendations.push({ code: 'CONFIRM_EXECUTION_ENDED_BEFORE_MORE_TESTS' });
  if (rows.some(row => row.structure?.applicable && row.structure.accepted === false)) recommendations.push({ code: 'STRUCTURE_FAILURE_INDEPENDENT_OF_TRANSPORT' });
  const suitable = groups.filter(group => group.count >= 3 && group.completed === group.count);
  if (suitable.length) recommendations.push({ code: 'OBSERVED_COMPLETING_CONCURRENCY', levels: [...new Set(suitable.map(group => group.concurrency))], confidence: 'sample_only' });
  else recommendations.push({ code: 'INSUFFICIENT_SAMPLES_FOR_CAPACITY' });
  const first = rows.filter(row => !row.warmup && row.transportComplete).map(row => row.metrics?.firstContentMs).filter(finite);
  if (first.length) recommendations.push({ code: 'FIRST_CONTENT_OBSERVED_RANGE_MS', ...distribution(first), notASafeTimeoutGuarantee: true });
  return recommendations;
}
const cell = value => value === null || value === undefined ? 'unavailable' : String(value).replace(/[\r\n|]/g, ' ');
export function renderSandboxReport(summary) {
  const metrics = Object.entries(summary.metrics).map(([key, value]) => `| ${key} | ${value.n} | ${cell(value.min)} | ${cell(value.median)} | ${cell(value.max)} |`).join('\n');
  const providerRows = Object.entries(summary.providerMetrics).filter(([, value]) => value.n).map(([key, value]) => `| ${key} | ${value.n} | ${cell(value.min)} | ${cell(value.median)} | ${cell(value.max)} |`).join('\n');
  const providerTable = providerRows ? `\n\nProvider-reported durations (nanoseconds; not client timings or inferred queue time):\n\n| Metric | Samples | Min | Median | Max |\n|---|---:|---:|---:|---:|\n${providerRows}` : '';
  const groups = summary.groupModes.map(group => `| ${cell(group.group)} | ${group.concurrency} | ${group.stream ? 'stream' : 'buffered'} | ${group.dispatched}/${group.count} | ${group.completed}/${group.count} | ${cell(group.firstContentMs.median)} | ${group.unknownUsageCalls} |`).join('\n');
  const calls = summary.perCall.map(row => `| ${cell(row.id)} | ${row.warmup ? 'warmup' : 'measured'} | ${row.stream ? 'stream' : 'buffered'} | ${cell(row.status)} | ${cell(row.metrics.firstContentMs)} | ${cell(row.metrics.totalMs)} | ${cell(row.usage.totalTokens)} | ${cell(row.endToEndCompletionTokensPerSecond)} |`).join('\n');
  return `# Local model sandbox\n\nStatus: ${cell(summary.status)}\n\nOrigin: ${cell(summary.origin)}\n\nPlan: ${summary.planHash}\n\nProvider: ${cell(summary.provider)}; model: ${cell(summary.model)}; suite: ${cell(summary.suite)}.\n\nPlanned: ${summary.planned}; warmup: ${summary.warmupCount}; dispatched: ${summary.dispatched}; unresolved: ${summary.unresolvedCalls}.\n\nMeasured transport complete: ${summary.transport.numerator}/${summary.transport.denominator} planned (${summary.transport.dispatchedDenominator} dispatched). Structure accepted: ${summary.structure.accepted}/${summary.structure.denominator} applicable planned cases. Failed, unknown and unsent cases remain in denominators.\n\nWarmup transport complete: ${summary.warmup.transport.numerator}/${summary.warmup.transport.denominator}; confirmed warmup tokens: ${summary.warmup.usage.confirmedTotalTokens}.\n\nConfirmed tokens (including warmup): ${summary.usage.confirmedTotalTokens}; calls with unknown usage: ${summary.usage.unknownUsageCalls}. Confirmed totals are a lower bound when usage is unknown. Zero and unavailable are distinct.\n\n| Metric | Samples | Min | Median | Max |\n|---|---:|---:|---:|---:|\n${metrics}\n\nFirst content: ${summary.metricDefinitions.firstContentMs}.${providerTable}\n\nToken rate: ${summary.rateDefinition}. SSE events and network chunks are never counted as tokens.\n\n## Groups and transport mode\n\n| Group | Concurrency | Mode | Dispatched/planned | Complete/planned | Median first content ms | Unknown usage |\n|---|---:|---|---:|---:|---:|---:|\n${groups}\n\n## Individual calls\n\n| Call | Role | Mode | Status | First content ms | Total ms | Total tokens | End-to-end completion tokens/s |\n|---|---|---|---|---:|---:|---:|---:|\n${calls}\n\n## Observations\n\n${summary.recommendations.map(item => '- ' + item.code + (item.levels ? ': ' + item.levels.join(', ') : '')).join('\n')}\n\nExternal load, server queue time, cold-start and cache status are unverified. Transport-complete samples remain performance observations even when structure fails. No semantic accuracy score or program verification certificate is inferred. No production settings were changed.\n`;
}
function regularFile(root, relative) {
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error();
  return file;
}
function readJson(root, relative) { return JSON.parse(fs.readFileSync(regularFile(root, relative), 'utf8')); }
function callFiles(root) {
  const dir = path.join(root, 'calls'), stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
  return fs.readdirSync(dir).filter(file => !/^.+\.\d+\.tmp$/.test(file)).map(file => 'calls/' + file).sort();
}
function expectedCalls(plan) { return plan.cases.map(item => `calls/${item.id}.json`).sort(); }
function sameList(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function validateRun(run, plan) {
  if (run.schemaVersion !== 1 || run.planHash !== plan.hash || run.planned !== plan.cases.length
    || !['running', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)
    || !['fixture', 'live_observation'].includes(run.origin)) throw Error();
}
function readRows(root, plan, files) {
  const byId = new Map(plan.cases.map(item => [item.id, item]));
  return files.map(file => {
    const row = readJson(root, file), item = byId.get(row.id);
    if (!item || file !== `calls/${item.id}.json` || ['group', 'concurrency', 'warmup', 'stream'].some(key => row[key] !== item[key])) throw Error();
    if (!STATUSES.includes(row.status) || ['dispatched', 'executionResolved', 'transportComplete', 'usageKnown'].some(key => typeof row[key] !== 'boolean')) throw Error();
    return row;
  });
}
export function publishSandbox(dir, run, summary) {
  try {
    const plan = validateSandboxPlan(readJson(dir, 'plan.json'));
    validateRun(run, plan);
    const files = callFiles(dir);
    if (!sameList(files, expectedCalls(plan))) throw Error();
    const rows = readRows(dir, plan, files);
    if (summary.planHash !== plan.hash || summary.planned !== plan.cases.length || rows.length !== summary.perCall.length) throw Error();
    const actual = summarizeSandbox(plan, rows, { origin: run.origin, elapsedMs: summary.elapsedMs, status: summary.status, resourceQueueMs: summary.resourceQueueMs, resourceIsolation: run.resourceIsolation });
    if (hash(actual) !== hash(summary)) throw Error();
    atomicJson(path.join(dir, 'summary.json'), summary);
    fs.writeFileSync(path.join(dir, 'report.md'), renderSandboxReport(summary), { mode: 0o600 });
    atomicJson(path.join(dir, 'run.json'), { ...run, status: summary.status, finishedAt: new Date().toISOString() });
    atomicJson(path.join(dir, 'manifest.json'), { schemaVersion: 1, planHash: plan.hash,
      files: [...REQUIRED_FILES, ...files].map(file => ({ file, hash: hash(fs.readFileSync(regularFile(dir, file))) })) });
  } catch { throw sandboxError('SANDBOX_ARTIFACT_INTEGRITY'); }
}
export function inspectSandbox(dir) {
  const root = path.resolve(dir), manifestFile = path.join(root, 'manifest.json');
  try {
    const plan = validateSandboxPlan(readJson(root, 'plan.json'));
    const run = readJson(root, 'run.json');
    validateRun(run, plan);
    const diskCalls = callFiles(root), expected = expectedCalls(plan);
    if (fs.existsSync(manifestFile)) {
      const manifest = readJson(root, 'manifest.json');
      if (manifest.schemaVersion !== 1 || manifest.planHash !== plan.hash || !Array.isArray(manifest.files)) throw Error();
      const expectedFiles = [...REQUIRED_FILES, ...expected].sort();
      if (!sameList(manifest.files.map(entry => entry.file).sort(), expectedFiles) || !sameList(diskCalls, expected)) throw Error();
      for (const entry of manifest.files) {
        if (!/^[a-f0-9]{64}$/.test(entry.hash || '') || hash(fs.readFileSync(regularFile(root, entry.file))) !== entry.hash) throw Error();
      }
      const rows = readRows(root, plan, diskCalls), summary = readJson(root, 'summary.json');
      const actual = summarizeSandbox(plan, rows, { origin: run.origin, elapsedMs: summary.elapsedMs, status: run.status, resourceQueueMs: summary.resourceQueueMs, resourceIsolation: run.resourceIsolation });
      if (hash(actual) !== hash(summary)) throw Error();
      return { runDir: root, complete: true, summary };
    }
    if (diskCalls.some(file => !expected.includes(file))) throw Error();
    const rows = readRows(root, plan, diskCalls);
    return { runDir: root, complete: false, status: run.status, planned: plan.cases.length, recorded: rows.length,
      dispatched: rows.filter(row => row.dispatched).length, notYetRecorded: plan.cases.length - rows.length,
      unresolvedCalls: rows.filter(row => row.dispatched && !row.executionResolved).length, requiresProcessCheck: true };
  } catch { throw sandboxError('SANDBOX_ARTIFACT_INTEGRITY'); }
}
function differences(left, right, prefix = '') {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => differences(left[key], right[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ field: prefix, left: left ?? null, right: right ?? null }];
}
export function compareSandboxes(leftDir, rightDir) {
  const left = inspectSandbox(leftDir), right = inspectSandbox(rightDir);
  if (!left.complete || !right.complete) throw sandboxError('SANDBOX_COMPARE_INCOMPLETE');
  const a = left.summary, b = right.summary, samePlan = a.planHash === b.planHash, sameOrigin = a.origin === b.origin;
  return { schemaVersion: 1, comparable: samePlan && sameOrigin,
    comparisonKind: !samePlan ? 'different-plans' : !sameOrigin ? 'different-origins' : 'repeated-plan', uncontrolledExternalLoad: true,
    parameterDifferences: differences(a.configuration, b.configuration), originDifference: sameOrigin ? null : { left: a.origin, right: b.origin },
    left: a, right: b, interpretation: samePlan && sameOrigin ? 'Observed differences; server load and cache are uncontrolled'
      : 'Descriptive comparison only; all input, setting and observation-origin differences remain visible; no winner or capacity conclusion inferred' };
}
