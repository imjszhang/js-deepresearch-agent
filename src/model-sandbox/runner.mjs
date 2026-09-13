import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLlmProvider, loadRecordedLlmRequest, parseStructuredResponse, STRUCTURED_RESPONSE_VERSION, executeSandboxRequest, acceptsClaimValidation } from 'js-deepresearch-engine';
import { createSandboxPlan, validateSandboxPlan, planIdentity } from './plan.mjs';
import { acquireSandboxResource, atomicJson, hash, sandboxError } from './resource.mjs';
import { summarizeSandbox, publishSandbox } from './artifacts.mjs';
import { safeResult, safeEventRecord } from './safe-record.mjs';

function endpointFor(provider, baseUrl) {
  const u = new URL(baseUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw sandboxError('SANDBOX_ENDPOINT_INVALID');
  return baseUrl.replace(/\/$/, '') + (provider === 'ollama' ? '/api/chat' : '/chat/completions');
}
export function createReplayPlan({ sessionDir, callId, mode, baseUrl, resourceId, timeouts, limits }) {
  if (!['exact', 'stream'].includes(mode) || !/^[a-zA-Z0-9_-]+$/.test(callId || '')) throw sandboxError('SANDBOX_REPLAY_INVALID');
  const { record, file } = loadRecordedLlmRequest({ sessionDir, callId });
  const provider = record.request.provider, body = record.request.body;
  const endpoint = endpointFor(provider, baseUrl);
  if (mode === 'exact' && endpoint !== record.request.endpoint) throw sandboxError('SANDBOX_IDENTITY_MISMATCH');
  const effective = replayBody(body, mode, provider);
  const plan = createSandboxPlan({ provider, model: body.model, baseUrl, resourceId, timeouts, limits: { ...limits, maxRequests: 3 }, suite: 'baseline', repetitions: 1 });
  const replay = { sessionDir: path.resolve(sessionDir), callId, mode, provider, model: body.model,
    requestFileHash: hash(fs.readFileSync(file)), originalBodyHash: hash(JSON.stringify(body)), effectiveBodyHash: hash(JSON.stringify(effective)),
    endpointHash: hash(record.request.endpoint), overrides: [
      ...['stream', 'stream_options'].filter(key => JSON.stringify(body[key]) !== JSON.stringify(effective[key])),
      ...(endpoint !== record.request.endpoint ? ['endpoint'] : []),
    ] };
  plan.suite = 'replay'; plan.cases = [{ id: 'replay-1', group: 'replay', concurrency: 1, warmup: false,
    messages: [], stream: effective.stream === true, temperature: 0, maxTokens: 0, validation: { kind: 'none' }, replay }];
  plan.limits.maxRequests = 1; plan.hash = planIdentity(plan); validateSandboxPlan(plan); return plan;
}
function replayBody(body, mode, provider) {
  return mode === 'exact' ? body : { ...body, stream: true, ...(provider === 'openai-compatible' ? { stream_options: { ...(body.stream_options || {}), include_usage: true } } : {}) };
}
function prepareRequest(plan, item) {
  if (item.replay) {
    const meta = item.replay, { record, file } = loadRecordedLlmRequest({ sessionDir: meta.sessionDir, callId: meta.callId });
    const body = replayBody(record.request.body, meta.mode, plan.provider);
    if (hash(fs.readFileSync(file)) !== meta.requestFileHash || hash(JSON.stringify(record.request.body)) !== meta.originalBodyHash
      || hash(JSON.stringify(body)) !== meta.effectiveBodyHash || hash(record.request.endpoint) !== meta.endpointHash
      || record.request.provider !== plan.provider || body.model !== plan.model
      || (meta.mode === 'exact' && record.request.endpoint !== endpointFor(plan.provider, plan.baseUrl))) throw sandboxError('SANDBOX_REPLAY_CHANGED');
    const effectiveEndpoint = endpointFor(plan.provider, plan.baseUrl);
    const actualOverrides = [...['stream', 'stream_options'].filter(key => JSON.stringify(record.request.body[key]) !== JSON.stringify(body[key])), ...(effectiveEndpoint !== record.request.endpoint ? ['endpoint'] : [])];
    if (JSON.stringify(actualOverrides) !== JSON.stringify(meta.overrides)) throw sandboxError('SANDBOX_REPLAY_CHANGED');
    return { endpoint: effectiveEndpoint, originalEndpointHash: meta.endpointHash, body, originalBodyHash: meta.originalBodyHash, effectiveBodyHash: meta.effectiveBodyHash, overrides: meta.overrides };
  }
  const provider = createLlmProvider({ llm: { provider: plan.provider, baseUrl: plan.baseUrl, model: plan.model, temperature: item.temperature, maxTokens: item.maxTokens ?? 0 }, http: {} });
  const request = provider.buildRecordedRequest({ messages: item.messages, temperature: item.temperature, maxTokens: item.maxTokens ?? 0 });
  const originalBodyHash = hash(JSON.stringify(request.body));
  request.body.stream = item.stream;
  if (plan.provider === 'openai-compatible' && item.stream) request.body.stream_options = { include_usage: true };
  if (plan.provider === 'ollama' && item.maxTokens > 0) request.body.options = { ...request.body.options, num_predict: item.maxTokens };
  return { ...request, originalBodyHash, effectiveBodyHash: hash(JSON.stringify(request.body)) };
}
function structureCheck(item, result, body) {
  if (!result.transportComplete) return { applicable: item.validation.kind !== 'none' || Boolean(item.replay), accepted: false, reason: 'transport_incomplete' };
  let accept, kind = item.validation.kind;
  if (item.replay) {
    // Recognize only the exact archived claim-validation request contract.
    let payload; try { payload = JSON.parse(body.messages?.find(message => message.role === 'user')?.content); } catch { /* plain request */ }
    if (Array.isArray(payload?.claims) && payload.claims.every(claim => claim.claimId && Array.isArray(claim.tasks) && Array.isArray(claim.comparisonPassages))) {
      kind = 'claims'; accept = value => acceptsClaimValidation(value, payload.claims);
    }
  }
  if (kind === 'none') return { applicable: false, accepted: null, reason: null };
  accept ||= value => {
    if (kind === 'json-object') return value && !Array.isArray(value) && typeof value === 'object';
    if (kind === 'enum') return item.validation.allowedValues.includes(value?.[item.validation.field]);
    if (kind === 'exact-ids') {
      const rows = value?.[item.validation.field], ids = item.validation.expectedIds;
      return Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(row => row?.[item.validation.idField])).size === ids.length
        && ids.every(id => rows.some(row => row?.[item.validation.idField] === id));
    }
    return false;
  };
  const parsed = parseStructuredResponse(result.text, { accept, metadata: { finishReason: result.finishReason } });
  return { applicable: true, accepted: parsed.ok, reason: parsed.reason, diagnostics: parsed.diagnostics, structuredResponseVersion: STRUCTURED_RESPONSE_VERSION };
}
export async function runSandbox({ plan, outputDir, apiKey, proxy, signal, onEvent = () => {}, resourceDir, execute = executeSandboxRequest }) {
  validateSandboxPlan(plan);
  plan = globalThis.structuredClone(plan);
  const requests = plan.cases.map(item => prepareRequest(plan, item));
  const runDir = path.resolve(outputDir || path.join('work_dir/model-sandbox', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')));
  resourceDir = path.resolve(resourceDir || 'work_dir/model-sandbox/.resources');
  for (const item of plan.cases.filter(item => item.replay)) {
    const source = fs.realpathSync(item.replay.sessionDir);
    for (const target of [runDir, resourceDir]) {
      let ancestor = target; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const resolved = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target));
      if (resolved === source || resolved.startsWith(source + path.sep)) throw sandboxError('SANDBOX_OUTPUT_OVERLAP');
    }
  }
  if (fs.existsSync(runDir) && (!fs.statSync(runDir).isDirectory() || fs.readdirSync(runDir).length)) throw sandboxError('SANDBOX_OUTPUT_NOT_EMPTY');
  fs.mkdirSync(path.join(runDir, 'calls'), { recursive: true });
  const origin = execute === executeSandboxRequest && !process.env.JDR_VERIFY_ACTIVE ? 'live_observation' : 'fixture';
  const started = performance.now(), runId = crypto.randomUUID(), controller = new AbortController();
  let stopReason = null, lease, resourceQueueMs = 0, pendingCalls;
  const cancel = () => { stopReason ||= 'cancelled'; controller.abort(); };
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const deadline = setTimeout(() => { stopReason ||= 'duration_limit'; controller.abort(); }, plan.limits.maxDurationMs);
  const run = { schemaVersion: 1, runId, status: 'running', origin, planHash: plan.hash, startedAt: new Date().toISOString(), planned: plan.cases.length };
  const eventFile = path.join(runDir, 'events.jsonl'); fs.writeFileSync(eventFile, '', { mode: 0o600 });
  atomicJson(path.join(runDir, 'plan.json'), plan); atomicJson(path.join(runDir, 'run.json'), run);
  const rows = plan.cases.map(item => ({ id: item.id, group: item.group, concurrency: item.concurrency, warmup: item.warmup,
    stream: item.stream, status: 'skipped', dispatched: false, executionResolved: true, transportComplete: false, usageKnown: false, structure: { applicable: item.validation.kind !== 'none' || Boolean(item.replay), accepted: null }, metrics: {} }));
  const lastProgress = new Map();
  const emit = event => {
    if (['content', 'reasoning'].includes(event.type)) {
      const key = event.callId + ':' + event.type, now = performance.now();
      if (lastProgress.has(key) && now - lastProgress.get(key) < 1000) return;
      lastProgress.set(key, now);
    }
    // Transport emits only protocol enums, counters and timestamps, never raw content.
    const safe = { ...safeEventRecord(event), runId, at: new Date().toISOString() };
    const fd = fs.openSync(eventFile, 'a', 0o600); try { fs.writeSync(fd, JSON.stringify(safe) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { onEvent(safe); } catch { /* observer cannot affect experiment */ }
  };
  const save = row => atomicJson(path.join(runDir, 'calls', row.id + '.json'), row);
  try {
    emit({ type: 'queued' });
    lease = await acquireSandboxResource({ resourceDir, resourceId: plan.resourceId, signal: controller.signal, queueMs: plan.timeouts.queueMs });
    resourceQueueMs = lease.queueMs;
    const groups = [...new Set(plan.cases.map(item => item.group))];
    for (const group of groups) {
      const queued = performance.now(), indexes = plan.cases.map((item, index) => item.group === group ? index : -1).filter(index => index >= 0);
      let cursor = 0;
      const worker = async () => {
        while (cursor < indexes.length && !stopReason && !controller.signal.aborted) {
          const index = indexes[cursor++], item = plan.cases[index], row = rows[index], request = requests[index];
          const queueMs = performance.now() - queued;
          if (queueMs >= plan.timeouts.queueMs) { row.reason = 'queue_timeout'; save(row); continue; }
          row.dispatched = true; row.executionResolved = false; row.status = 'outcome_unknown'; row.dispatchedOffsetMs = performance.now() - started;
          row.request = { endpointHash: hash(request.endpoint), originalEndpointHash: request.originalEndpointHash || hash(request.endpoint), bodyHash: request.effectiveBodyHash, originalBodyHash: request.originalBodyHash, overrides: request.overrides || [], inputBytes: Buffer.byteLength(JSON.stringify(request.body)), inputChars: (request.body.messages || []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) };
          lease.start(row.id, runId); save(row); emit({ type: 'dispatch', callId: row.id, queueMs, group });
          let result;
          try {
            result = await execute({ provider: plan.provider, endpoint: request.endpoint, body: request.body, apiKey, proxy,
              signal: controller.signal, timeouts: Object.fromEntries(Object.entries(plan.timeouts).filter(([key]) => key !== 'queueMs')), maxResponseBytes: plan.limits.maxResponseBytes, cancelAfterMs: item.cancelAfterMs ?? null,
              onEvent: event => emit({ ...event, callId: row.id }) });
          } catch { result = { status: 'outcome_unknown', executionResolved: false, transportComplete: false, usageKnown: false,
            text: '', error: { code: 'SANDBOX_EXECUTOR_ERROR', phase: 'execution' }, metrics: {} }; }
          const text = typeof result.text === 'string' ? result.text : '';
          result = { ...safeResult(result), text };
          const record = safeResult(result);
          Object.assign(row, record, { endedOffsetMs: performance.now() - started, responseHash: hash(text),
            metrics: { ...result.metrics, queueMs }, structure: structureCheck(item, result, request.body) });
          row.endedAt = new Date().toISOString();
          if (!row.executionResolved) stopReason ||= 'outcome_unknown';
          save(row); lease.finish(row.id, runId, row.executionResolved);
          emit({ type: 'call_finished', callId: row.id, status: row.status, transportComplete: row.transportComplete, executionResolved: row.executionResolved, structureAccepted: row.structure.accepted });
        }
      };
      const outcomes = await Promise.allSettled(Array.from({ length: plan.cases[indexes[0]].concurrency }, async () => {
        try { await worker(); } catch (error) { stopReason ||= 'sandbox_error'; controller.abort(); throw error; }
      }));
      if (outcomes.some(outcome => outcome.status === 'rejected')) stopReason ||= 'sandbox_error';
      if (stopReason || controller.signal.aborted) break;
    }
  } catch (error) {
    const allowed = ['SANDBOX_CANCELLED', 'SANDBOX_QUEUE_TIMEOUT', 'SANDBOX_EXECUTION_UNRESOLVED'];
    stopReason ||= allowed.includes(error.code) ? error.code : 'sandbox_error';
    emit({ type: 'stopped', reason: stopReason });
  } finally {
    clearTimeout(deadline); signal?.removeEventListener('abort', cancel); pendingCalls = lease?.pendingCount() || 0; lease?.close();
  }
  for (const row of rows) { if (!row.dispatched) row.reason ||= stopReason || 'not_dispatched'; save(row); }
  const unresolved = rows.some(row => row.dispatched && !row.executionResolved);
  const status = stopReason === 'cancelled' || stopReason === 'SANDBOX_CANCELLED' ? 'cancelled'
    : unresolved || stopReason === 'SANDBOX_EXECUTION_UNRESOLVED' ? 'outcome_unknown'
    : stopReason || rows.some(row => row.status !== 'completed') ? 'failed' : 'completed';
  run.resourceIsolation = { blocked: pendingCalls > 0 || stopReason === 'SANDBOX_EXECUTION_UNRESOLVED', pendingCalls: stopReason === 'SANDBOX_EXECUTION_UNRESOLVED' ? null : pendingCalls };
  const summary = summarizeSandbox(plan, rows, { origin, status, resourceQueueMs, resourceIsolation: run.resourceIsolation, elapsedMs: performance.now() - started });
  emit({ type: 'run_finished', status }); publishSandbox(runDir, run, summary);
  return { runDir, summary };
}
