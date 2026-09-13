import { performance } from 'node:perf_hooks';
import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { parseStructuredResponse } from '../research/structured-response.mjs';

export const SANDBOX_TIMEOUTS = Object.freeze({ headersMs: 900_000, firstEventMs: 900_000, idleMs: 120_000, totalMs: 1_800_000 });
const REASONS = new Set(['stop', 'length', 'max_tokens', 'max_output_tokens', 'content_filter', 'tool_calls', 'function_call', 'load', 'unload']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeReason = (value) => typeof value === 'string' && value ? (REASONS.has(value) ? value : 'other') : null;
const token = (value) => Number.isSafeInteger(value) && value >= 0;

class TransportFailure extends Error {
  constructor(code, phase, detail = {}) { super(code); this.safe = { code, phase, ...detail }; }
}

function json(raw) {
  // Native parsing enforces a complete wire envelope; the shared parser additionally rejects duplicate keys.
  try { JSON.parse(raw); } catch { throw new TransportFailure('INVALID_PROTOCOL_JSON', 'protocol'); }
  const result = parseStructuredResponse(raw, { rootType: 'object', maxInputChars: Math.max(1, raw.length), maxScanChars: Math.max(1, raw.length * 8), maxDepth: 128 });
  if (!result.ok) throw new TransportFailure('INVALID_PROTOCOL_JSON', 'protocol');
  return result.parsed;
}

function contentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new TransportFailure('UNSUPPORTED_CONTENT', 'protocol');
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (object(part) && (!part.type || part.type === 'text') && typeof part.text === 'string') return part.text;
    throw new TransportFailure('UNSUPPORTED_CONTENT', 'protocol');
  }).join('');
}

function usageFor(provider, data) {
  const promptTokens = provider === 'ollama' ? data.prompt_eval_count : data.usage?.prompt_tokens;
  const completionTokens = provider === 'ollama' ? data.eval_count : data.usage?.completion_tokens;
  const reported = provider === 'ollama' ? undefined : data.usage?.total_tokens;
  if (!token(promptTokens) || !token(completionTokens)) return null;
  const totalTokens = promptTokens + completionTokens;
  if (!token(totalTokens) || (reported !== undefined && (!token(reported) || reported !== totalTokens))) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/** Observe one request only. Returned text stays in memory; observer events never contain model text. */
export async function executeSandboxRequest({ provider, endpoint, body, apiKey, proxy, signal, timeouts = {}, onEvent, fetch: providedFetch, maxResponseBytes = 16 * 1024 * 1024, cancelAfterMs = null } = {}) {
  const started = performance.now();
  const metrics = { headersMs: null, firstBodyMs: null, firstEventMs: null, firstReasoningMs: null, firstContentMs: null, lastContentMs: null, lastActivityMs: null, totalMs: 0, maxActivityGapMs: 0, contentChars: 0, reasoningChars: 0, events: 0, bytes: 0 };
  const result = { status: 'failed', transportComplete: false, executionResolved: true, usageKnown: false, usage: null, text: '', finishReason: null, metrics, providerMetrics: {}, error: null };
  const elapsed = () => performance.now() - started;
  const emit = (type, detail = {}) => { try { const pending = onEvent?.({ type, elapsedMs: elapsed(), ...detail }); pending?.catch?.(() => {}); } catch { /* Telemetry cannot change request execution. */ } };
  const controller = new AbortController();
  const timers = new Map();
  let reader;
  let sent = false;
  let stopped = null;
  let lastActivity = null;
  let terminal = false;
  let finishedChoice = false;
  let eof = false;
  let phase = 'configuration';
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // A cancellation before the first race must not become an unhandled rejection.
  aborted.catch(() => {});
  const stop = (code, stopPhase) => {
    if (stopped) return;
    stopped = new TransportFailure(code, stopPhase);
    controller.abort();
    rejectAbort(stopped);
  };
  const clear = (name) => { clearTimeout(timers.get(name)); timers.delete(name); };
  const arm = (name, ms, code, timerPhase) => { clear(name); if (ms > 0) timers.set(name, setTimeout(() => stop(code, timerPhase), ms)); };
  const race = (promise) => Promise.race([promise, aborted]);
  const onAbort = () => stop('CANCELLED', phase);
  let limits;
  const progress = (kind, text) => {
    if (!text.length) return;
    const at = elapsed();
    if (lastActivity != null) metrics.maxActivityGapMs = Math.max(metrics.maxActivityGapMs, at - lastActivity);
    lastActivity = at; metrics.lastActivityMs = at;
    if (metrics.firstEventMs == null) { metrics.firstEventMs = at; clear('first'); }
    if (kind === 'content') {
      if (metrics.firstContentMs == null) metrics.firstContentMs = at;
      metrics.lastContentMs = at;
      metrics.contentChars += text.length;
      result.text += text;
    } else {
      if (metrics.firstReasoningMs == null) metrics.firstReasoningMs = at;
      metrics.reasoningChars += text.length;
    }
    arm('idle', limits.idleMs, 'IDLE_TIMEOUT', 'generation');
    emit(kind === 'content' ? 'content' : 'reasoning', { chars: text.length });
  };
  const effectiveEvent = () => {
    if (metrics.firstEventMs == null) { metrics.firstEventMs = elapsed(); clear('first'); }
  };
  const consume = (data, streaming) => {
    if (!object(data)) throw new TransportFailure('INVALID_PROTOCOL_SHAPE', 'protocol');
    metrics.events += 1;
    if (terminal) throw new TransportFailure('EVENT_AFTER_TERMINAL', 'protocol');
    if (data.error != null) throw new TransportFailure('PROVIDER_RESPONSE_ERROR', 'protocol');
    let message;
    if (provider === 'openai-compatible') {
      if (!Array.isArray(data.choices)) throw new TransportFailure('INVALID_PROTOCOL_SHAPE', 'protocol');
      if (data.choices.length > 1 || (data.choices[0]?.index != null && data.choices[0].index !== 0)) throw new TransportFailure('UNSUPPORTED_MULTIPLE_CHOICES', 'protocol');
      const choice = data.choices[0];
      if (!choice && !(streaming && object(data.usage))) throw new TransportFailure('INVALID_PROTOCOL_SHAPE', 'protocol');
      message = choice ? (streaming ? choice.delta : choice.message) : null;
      if (choice && !object(message)) throw new TransportFailure('INVALID_PROTOCOL_SHAPE', 'protocol');
      if (finishedChoice && choice) throw new TransportFailure('DUPLICATE_FINISH_EVENT', 'protocol');
      const reason = safeReason(choice?.finish_reason);
      if (reason) { result.finishReason = reason; finishedChoice = true; effectiveEvent(); emit('finish', { finishReason: reason }); }
    } else {
      if (typeof data.done !== 'boolean' || (!object(data.message) && !data.done)) throw new TransportFailure('INVALID_PROTOCOL_SHAPE', 'protocol');
      message = data.message;
      if (data.done) { terminal = true; result.finishReason = safeReason(data.done_reason); effectiveEvent(); emit('finish', { finishReason: result.finishReason }); }
    }
    if (message?.tool_calls != null || message?.function_call != null || message?.refusal != null) throw new TransportFailure('UNSUPPORTED_CONTENT', 'protocol');
    progress('reasoning', contentText(message?.reasoning_content ?? message?.reasoning ?? message?.thinking));
    progress('content', contentText(message?.content));
    if (provider === 'ollama') {
      for (const [source, target] of Object.entries({ total_duration: 'totalDurationNs', load_duration: 'loadDurationNs', prompt_eval_duration: 'promptEvalDurationNs', eval_duration: 'evalDurationNs' })) {
        if (token(data[source])) result.providerMetrics[target] = data[source];
      }
    }
    const usage = usageFor(provider, data);
    // Intermediate counters do not establish final request usage after a later interruption.
    if (usage && (provider === 'ollama' ? terminal : finishedChoice)) {
      if (result.usage && JSON.stringify(result.usage) !== JSON.stringify(usage)) throw new TransportFailure('CONFLICTING_USAGE', 'protocol');
      result.usage = usage; result.usageKnown = true; emit('usage', { ...usage });
    }
  };
  try {
    if (!['openai-compatible', 'ollama'].includes(provider) || !object(body) || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new TransportFailure('INVALID_CONFIGURATION', phase);
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TransportFailure('INVALID_CONFIGURATION', phase);
    limits = { ...SANDBOX_TIMEOUTS, ...timeouts };
    if (Object.keys(timeouts).some((key) => !(key in SANDBOX_TIMEOUTS)) || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) || (cancelAfterMs != null && (!Number.isSafeInteger(cancelAfterMs) || cancelAfterMs < 0 || cancelAfterMs > 2_147_483_647))) throw new TransportFailure('INVALID_CONFIGURATION', phase);
    if (body.stream != null && typeof body.stream !== 'boolean') throw new TransportFailure('INVALID_CONFIGURATION', phase);
    const encodedBody = JSON.stringify(body);
    const fetchImpl = providedFetch || createHttpFetch(proxy, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
    if (signal?.aborted) throw new TransportFailure('CANCELLED', 'queue');
    signal?.addEventListener('abort', onAbort, { once: true });
    phase = 'headers'; sent = true; result.executionResolved = false;
    arm('headers', limits.headersMs, 'HEADERS_TIMEOUT', 'headers');
    arm('total', limits.totalMs, 'TOTAL_TIMEOUT', 'total');
    if (cancelAfterMs != null) timers.set('cancel', setTimeout(() => stop('CANCELLED', phase), cancelAfterMs));
    emit('sent');
    const response = await race(fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: encodedBody, signal: controller.signal }));
    metrics.headersMs = elapsed(); clear('headers'); emit('headers', { status: response.status });
    if (!response.ok) {
      result.executionResolved = true;
      response.body?.cancel().catch(() => {});
      throw new TransportFailure('HTTP_ERROR', 'headers', { httpStatus: response.status });
    }
    phase = 'first_event';
    arm('first', limits.firstEventMs, 'FIRST_EVENT_TIMEOUT', 'first_event');
    if (!response.body?.getReader) throw new TransportFailure('MISSING_RESPONSE_BODY', 'body');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (bytes, options) => { try { return decoder.decode(bytes, options); } catch { throw new TransportFailure('INVALID_UTF8', 'body'); } };
    const streaming = body.stream === true;
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (streaming && provider === 'openai-compatible' && type !== 'text/event-stream') throw new TransportFailure('UNSUPPORTED_CONTENT_TYPE', 'headers');
    if (streaming && provider === 'ollama' && !['application/x-ndjson', 'application/json', 'application/jsonl'].includes(type)) throw new TransportFailure('UNSUPPORTED_CONTENT_TYPE', 'headers');
    if (!streaming && type !== 'application/json') throw new TransportFailure('UNSUPPORTED_CONTENT_TYPE', 'headers');
    let pending = '';
    let eventData = [];
    const line = (value) => {
      if (provider === 'ollama') { if (value.trim()) consume(json(value), true); return; }
      if (!value) {
        if (!eventData.length) return;
        const payload = eventData.join('\n'); eventData = [];
        if (payload === '[DONE]') {
          if (terminal) throw new TransportFailure('DUPLICATE_TERMINAL', 'protocol');
          terminal = true; metrics.events += 1; effectiveEvent(); clear('first'); clear('idle'); emit('terminal');
        } else consume(json(payload), true);
      } else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
      else if (value === 'data') eventData.push('');
      // SSE comments and metadata fields do not indicate generation progress.
    };
    const processLines = (final = false) => {
      let match;
      while ((match = /[\r\n]/.exec(pending))) {
        const at = match.index;
        if (!final && pending[at] === '\r' && at + 1 === pending.length) break;
        const width = pending[at] === '\r' && pending[at + 1] === '\n' ? 2 : 1;
        const value = pending.slice(0, at); pending = pending.slice(at + width); line(value);
      }
      if (final && pending) {
        // NDJSON permits its final JSON record without a newline; SSE needs a blank event separator.
        if (provider === 'ollama') { line(pending); pending = ''; }
      }
    };
    while (true) {
      const item = await race(reader.read());
      if (item.done) { eof = true; break; }
      if (!item.value?.byteLength) continue;
      if (metrics.firstBodyMs == null) { metrics.firstBodyMs = elapsed(); emit('first_body'); }
      metrics.bytes += item.value.byteLength;
      if (metrics.bytes > maxResponseBytes) throw new TransportFailure('RESPONSE_TOO_LARGE', 'body');
      pending += decode(item.value, { stream: true });
      if (streaming) processLines();
      if (metrics.firstEventMs != null) phase = 'generation';
    }
    pending += decode();
    if (streaming) {
      processLines(true);
      if ((provider === 'openai-compatible' && (pending.trim() || eventData.length)) || !terminal || (provider === 'openai-compatible' && !finishedChoice)) throw new TransportFailure('INCOMPLETE_PROTOCOL', 'protocol');
    } else {
      consume(json(pending), false);
      if (provider === 'openai-compatible' && !finishedChoice || provider === 'ollama' && !terminal) throw new TransportFailure('INCOMPLETE_PROTOCOL', 'protocol');
      terminal = true;
    }
    result.transportComplete = true; result.executionResolved = true; result.status = 'completed';
  } catch (error) {
    const failure = stopped || (error instanceof TransportFailure ? error : new TransportFailure(phase === 'configuration' ? 'INVALID_CONFIGURATION' : 'TRANSPORT_ERROR', phase));
    result.executionResolved ||= !sent || terminal || finishedChoice;
    result.error = failure.safe;
    result.status = failure.safe.code === 'CANCELLED' ? 'cancelled' : (result.executionResolved ? 'failed' : 'outcome_unknown');
  } finally {
    for (const timer of timers.values()) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!eof) { controller.abort(); reader?.cancel().catch(() => {}); }
    metrics.totalMs = elapsed();
    if (lastActivity != null) metrics.maxActivityGapMs = Math.max(metrics.maxActivityGapMs, metrics.totalMs - lastActivity);
    emit('complete', { status: result.status, executionResolved: result.executionResolved, transportComplete: result.transportComplete, usageKnown: result.usageKnown });
  }
  return result;
}
