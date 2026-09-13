import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpFetch, resetHttpFetchCache } from '../src/http/create-http-fetch.mjs';
import { executeSandboxRequest } from '../src/llm/sandbox-transport.mjs';

const limits = { headersMs: 2000, firstEventMs: 2000, idleMs: 2000, totalMs: 5000 };
const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const choice = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const sse = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const args = (extra = {}) => ({ provider: 'openai-compatible', endpoint: 'http://127.0.0.1:1/chat/completions', body: { model: 'fixture', messages: [], stream: true }, timeouts: limits, ...extra });

async function server(t, handler) {
  const sockets = new Set();
  const instance = createServer(handler);
  instance.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}/chat/completions`;
}

function fakeResponse(text, type = 'text/event-stream', chunks = null) {
  return async () => new globalThis.Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks || [Buffer.from(text)]) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { 'content-type': type } });
}

function goodStream(text = 'ok') { return sse(choice({ content: text })) + sse(choice({}, 'stop')) + sse({ choices: [], usage }) + sse('[DONE]'); }

test('[V25] sandbox observes real loopback SSE with split UTF-8, CRLF, multiline data and trailing usage', async (t) => {
  const observed = [];
  let requests = 0;
  const endpoint = await server(t, async (req, res) => {
    requests += 1;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).stream, true);
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' }); res.flushHeaders();
    res.write(': heartbeat\r\n\r\n');
    await delay(15);
    const wire = sse(choice({ reasoning_content: 'private reasoning marker' })) + 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文😀"},"finish_reason":null}]}\r\n\r\n' + sse(choice({}, 'stop')) + sse({ choices: [], usage }) + sse('[DONE]');
    for (const byte of Buffer.from(wire)) res.write(Buffer.from([byte]));
    res.end();
  });
  const result = await executeSandboxRequest(args({ endpoint, apiKey: 'test-secret', onEvent: (event) => observed.push(event) }));
  assert.equal(result.status, 'completed'); assert.equal(result.transportComplete, true); assert.equal(result.executionResolved, true);
  assert.equal(result.text, '中文😀'); assert.equal(result.metrics.contentChars, 4); assert.equal(result.metrics.reasoningChars, 24);
  assert.equal(result.metrics.events, 5); assert.equal(result.usageKnown, true); assert.equal(result.usage.totalTokens, 7);
  assert.ok(result.metrics.headersMs <= result.metrics.firstBodyMs);
  assert.ok(result.metrics.firstBodyMs <= result.metrics.firstEventMs);
  assert.ok(result.metrics.firstReasoningMs <= result.metrics.firstContentMs);
  assert.ok(result.metrics.firstContentMs <= result.metrics.totalMs);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(observed), /private reasoning|test-secret|中文/);
});

test('sandbox supports complete OpenAI JSON and does not invent missing usage', async () => {
  const data = { choices: [{ message: { content: [{ type: 'text', text: 'answer' }] }, finish_reason: 'stop' }] };
  const result = await executeSandboxRequest(args({ body: { stream: false }, fetch: fakeResponse(JSON.stringify(data), 'application/json') }));
  assert.equal(result.status, 'completed'); assert.equal(result.usageKnown, false); assert.equal(result.usage, null); assert.equal(result.text, 'answer');
  assert.equal(result.executionResolved, true);
});

test('[V25] sandbox supports Ollama NDJSON including last record without newline', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { thinking: 'private', content: '你' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: '好' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 9 }));
  });
  const result = await executeSandboxRequest(args({ endpoint, provider: 'ollama' }));
  assert.equal(result.status, 'completed'); assert.equal(result.text, '你好'); assert.equal(result.metrics.reasoningChars, 7);
  assert.deepEqual(result.usage, { promptTokens: 8, completionTokens: 9, totalTokens: 17 });
});

test('sandbox supports Ollama complete JSON', async () => {
  const data = { message: { content: 'hello' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 0 };
  const result = await executeSandboxRequest(args({ provider: 'ollama', body: { stream: false }, fetch: fakeResponse(JSON.stringify(data), 'application/json') }));
  assert.equal(result.status, 'completed'); assert.equal(result.usage.totalTokens, 8);
});

test('[V25] sandbox headers timeout makes one request and does not disclose transport errors', async (t) => {
  let requests = 0;
  const endpoint = await server(t, () => { requests += 1; });
  const events = [];
  const result = await executeSandboxRequest(args({ endpoint, timeouts: { ...limits, headersMs: 80 }, onEvent: (event) => events.push(event) }));
  assert.equal(result.status, 'outcome_unknown'); assert.equal(result.error.code, 'HEADERS_TIMEOUT'); assert.equal(result.error.phase, 'headers');
  assert.equal(result.executionResolved, false); assert.equal(requests, 1); assert.equal(result.metrics.headersMs, null);
  assert.equal(events.at(-1).type, 'complete');
});

test('[V25] sandbox heartbeat and role events do not satisfy first effective event timeout', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ping\n\n' + sse(choice({ role: 'assistant' })));
    const timer = setInterval(() => res.write(': ping\n\n'), 10); res.on('close', () => clearInterval(timer));
  });
  const result = await executeSandboxRequest(args({ endpoint, timeouts: { ...limits, firstEventMs: 80 } }));
  assert.equal(result.error.code, 'FIRST_EVENT_TIMEOUT'); assert.equal(result.metrics.firstEventMs, null); assert.equal(result.status, 'outcome_unknown');
});

test('[V25] sandbox reasoning resets idle timeout without persisting reasoning text', async (t) => {
  const events = [];
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let count = 0;
    const timer = setInterval(() => {
      res.write(sse(choice({ reasoning_content: 'SECRET_REASONING' })));
      if (++count === 5) { clearInterval(timer); res.end(goodStream('ok')); }
    }, 25);
    res.on('close', () => clearInterval(timer));
  });
  const result = await executeSandboxRequest(args({ endpoint, timeouts: { ...limits, idleMs: 75 }, onEvent: (event) => events.push(event) }));
  assert.equal(result.status, 'completed'); assert.equal(result.metrics.reasoningChars, 80); assert.ok(result.metrics.firstReasoningMs < result.metrics.firstContentMs);
  assert.doesNotMatch(JSON.stringify({ result, events }), /SECRET_REASONING/);
});

test('[V25] sandbox idle timeout fires despite heartbeat traffic after content', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(choice({ content: 'first' })));
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 10); res.on('close', () => clearInterval(timer));
  });
  const result = await executeSandboxRequest(args({ endpoint, timeouts: { ...limits, idleMs: 80 } }));
  assert.equal(result.error.code, 'IDLE_TIMEOUT'); assert.equal(result.text, 'first'); assert.equal(result.executionResolved, false);
  assert.ok(result.metrics.maxActivityGapMs >= 65);
});

test('[V25] sandbox total timeout bounds an otherwise progressing stream', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write(sse(choice({ content: '.' }))), 15); res.on('close', () => clearInterval(timer));
  });
  const result = await executeSandboxRequest(args({ endpoint, timeouts: { ...limits, totalMs: 100 } }));
  assert.equal(result.error.code, 'TOTAL_TIMEOUT'); assert.equal(result.executionResolved, false); assert.ok(result.metrics.contentChars > 0);
});

test('sandbox cancellation before dispatch sends no request and execution is resolved', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await executeSandboxRequest(args({ signal: controller.signal, fetch: () => { calls += 1; } }));
  assert.equal(result.status, 'cancelled'); assert.equal(result.executionResolved, true); assert.equal(calls, 0);
});

test('sandbox timed cancellation cannot claim that server execution has ended', async (t) => {
  let calls = 0;
  const endpoint = await server(t, (_req, res) => { calls += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(choice({ content: 'pending' }))); });
  const result = await executeSandboxRequest(args({ endpoint, cancelAfterMs: 80 }));
  assert.equal(result.status, 'cancelled'); assert.equal(result.executionResolved, false); assert.equal(result.transportComplete, false); assert.equal(calls, 1);
});

test('[V25] sandbox timeout is enforced even when an injected fetch ignores abort', async () => {
  const result = await executeSandboxRequest(args({ fetch: () => new Promise(() => {}), timeouts: { ...limits, headersMs: 20 } }));
  assert.equal(result.error.code, 'HEADERS_TIMEOUT'); assert.ok(result.metrics.totalMs < 500);
});

test('sandbox explicit HTTP rejection is resolved without logging provider error body or retrying', async (t) => {
  let calls = 0;
  const endpoint = await server(t, (_req, res) => { calls += 1; res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"SECRET_PROVIDER_ERROR"}'); });
  const result = await executeSandboxRequest(args({ endpoint }));
  assert.equal(result.status, 'failed'); assert.equal(result.executionResolved, true); assert.equal(result.error.httpStatus, 429); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROVIDER_ERROR/);
});

const failureCases = [
  ['missing DONE', sse(choice({ content: 'x' })), 'INCOMPLETE_PROTOCOL', false],
  ['finish without DONE', sse(choice({}, 'stop')), 'INCOMPLETE_PROTOCOL', true],
  ['DONE without finish', sse('[DONE]'), 'INCOMPLETE_PROTOCOL', true],
  ['duplicate DONE', goodStream() + sse('[DONE]'), 'DUPLICATE_TERMINAL', true],
  ['event after DONE', goodStream() + sse(choice({ content: 'bad' })), 'EVENT_AFTER_TERMINAL', true],
  ['duplicate finish', sse(choice({}, 'stop')) + sse(choice({}, 'stop')), 'DUPLICATE_FINISH_EVENT', true],
  ['partial event', sse(choice({ content: 'x' })) + 'data: {', 'INCOMPLETE_PROTOCOL', false],
  ['malformed event', 'data: {oops}\n\n', 'INVALID_PROTOCOL_JSON', false],
  ['duplicate JSON key', 'data: {"choices":[],"choices":[]}\n\n', 'INVALID_PROTOCOL_JSON', false],
  ['multiple choices', sse({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }), 'UNSUPPORTED_MULTIPLE_CHOICES', false],
  ['tool calls', sse(choice({ tool_calls: [] })), 'UNSUPPORTED_CONTENT', false],
  ['unknown content part', sse(choice({ content: [{ type: 'image_url', image_url: 'secret' }] })), 'UNSUPPORTED_CONTENT', false],
  ['provider error event', sse({ error: 'SECRET_MODEL_ERROR' }), 'PROVIDER_RESPONSE_ERROR', false],
  ['conflicting usage', sse(choice({}, 'stop')) + sse({ choices: [], usage }) + sse({ choices: [], usage: { ...usage, total_tokens: 8, completion_tokens: 5 } }), 'CONFLICTING_USAGE', true],
];
for (const [name, wire, code, resolved] of failureCases) test(`sandbox rejects ${name}`, async () => {
  const result = await executeSandboxRequest(args({ fetch: fakeResponse(wire) }));
  assert.equal(result.error?.code, code); assert.equal(result.transportComplete, false); assert.equal(result.executionResolved, resolved);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_MODEL_ERROR/);
});

test('[V25] sandbox complete JSON must be exactly one envelope without prose or duplicate keys', async () => {
  for (const wire of ['prefix {"choices":[]}', '{"choices":[],"choices":[]}']) {
    const result = await executeSandboxRequest(args({ body: { stream: false }, fetch: fakeResponse(wire, 'application/json') }));
    assert.equal(result.error.code, 'INVALID_PROTOCOL_JSON');
  }
});

test('sandbox rejects response overflow before retaining unbounded content', async () => {
  const result = await executeSandboxRequest(args({ fetch: fakeResponse(goodStream('x'.repeat(200))), maxResponseBytes: 100 }));
  assert.equal(result.error.code, 'RESPONSE_TOO_LARGE'); assert.equal(result.text, '');
});

test('sandbox exact stream request cannot silently downgrade to complete JSON', async () => {
  const result = await executeSandboxRequest(args({ fetch: fakeResponse('{"choices":[]}', 'application/json') }));
  assert.equal(result.error.code, 'UNSUPPORTED_CONTENT_TYPE'); assert.equal(result.executionResolved, false);
});

test('sandbox invalid configuration cannot dispatch or disclose endpoint credentials', async () => {
  for (const extra of [{ endpoint: 'http://user:SECRET@localhost' }, { endpoint: 'bad SECRET' }, { timeouts: { headersMs: -1 } }, { timeouts: { surprise: 100 } }, { provider: 'other' }, { cancelAfterMs: -1 }]) {
    let count = 0;
    const result = await executeSandboxRequest(args({ ...extra, fetch: () => { count += 1; } }));
    assert.equal(result.error.code, 'INVALID_CONFIGURATION'); assert.equal(result.executionResolved, true); assert.equal(count, 0); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('sandbox redacts arbitrary thrown transport errors', async () => {
  const result = await executeSandboxRequest(args({ fetch: async () => { throw new Error('SECRET_ADDRESS_AND_PROMPT'); } }));
  assert.equal(result.error.code, 'TRANSPORT_ERROR'); assert.equal(result.executionResolved, false); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('sandbox keeps non-numeric, partial and inconsistent usage unknown without losing terminal success', async () => {
  for (const reported of [{ total_tokens: 7 }, { ...usage, prompt_tokens: '3' }, { ...usage, total_tokens: 99 }, { ...usage, completion_tokens: -1 }]) {
    const wire = sse(choice({}, 'stop')) + sse({ choices: [], usage: reported }) + sse('[DONE]');
    const result = await executeSandboxRequest(args({ fetch: fakeResponse(wire) }));
    assert.equal(result.status, 'completed'); assert.equal(result.usageKnown, false); assert.equal(result.usage, null);
  }
});

test('sandbox tolerates arbitrary byte boundaries and telemetry callback exceptions', async () => {
  const wire = goodStream('中文😀').replace(/\n/g, '\r\n');
  const bytes = [...Buffer.from(wire)].map((value) => Buffer.from([value]));
  const result = await executeSandboxRequest(args({ fetch: fakeResponse('', 'text/event-stream', bytes), onEvent: () => { throw new Error('SECRET'); } }));
  assert.equal(result.status, 'completed'); assert.equal(result.text, '中文😀');
});

test('sandbox socket disconnect after partial content remains unresolved', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(choice({ content: 'partial' })));
    setTimeout(() => res.destroy(), 15);
  });
  const result = await executeSandboxRequest(args({ endpoint }));
  assert.equal(result.status, 'outcome_unknown'); assert.equal(result.transportComplete, false); assert.equal(result.text, 'partial');
});

test('sandbox external cancellation during body consumption releases client resources, not server capacity', async (t) => {
  const controller = new AbortController();
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(choice({ content: 'partial' })));
  });
  const result = await executeSandboxRequest(args({ endpoint, signal: controller.signal, onEvent: (event) => { if (event.type === 'content') controller.abort(); } }));
  assert.equal(result.status, 'cancelled'); assert.equal(result.executionResolved, false); assert.equal(result.text, 'partial');
});

test('sandbox rejects malformed UTF-8 instead of repairing wire bytes', async () => {
  const result = await executeSandboxRequest(args({ fetch: fakeResponse('', 'text/event-stream', [Buffer.from([0xc3, 0x28])]) }));
  assert.equal(result.error.code, 'INVALID_UTF8'); assert.equal(result.transportComplete, false);
});

test('sandbox finish reasons are enum values in results and persisted observer events', async () => {
  const events = [];
  const result = await executeSandboxRequest(args({ fetch: fakeResponse(sse(choice({}, 'SECRET_FREEFORM_FINISH')) + sse('[DONE]')), onEvent: (event) => events.push(event) }));
  assert.equal(result.status, 'completed'); assert.equal(result.finishReason, 'other');
  assert.doesNotMatch(JSON.stringify({ result, events }), /SECRET_FREEFORM_FINISH/);
});

test('sandbox missing Ollama done marker is not a completed response', async () => {
  const result = await executeSandboxRequest(args({ provider: 'ollama', fetch: fakeResponse('{"message":{"content":"partial"},"done":false}\n', 'application/x-ndjson') }));
  assert.equal(result.error.code, 'INCOMPLETE_PROTOCOL'); assert.equal(result.executionResolved, false);
});

async function tunnelProxy(t) {
  const sockets = new Set();
  const instance = createServer();
  instance.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  instance.on('connect', (req, client, head) => {
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

for (const proxied of [false, true]) test(`sandbox explicit dispatcher deadlines are effective and zero disables them (${proxied ? 'HTTP proxy' : 'direct'})`, async (t) => {
  t.after(() => resetHttpFetchCache());
  const endpoint = await server(t, (req, res) => {
    if (req.url.endsWith('/body')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('start'); }
    const timer = setTimeout(() => res.end('done'), 1600);
    res.on('close', () => clearTimeout(timer));
  });
  const proxy = proxied ? await tunnelProxy(t) : '';
  const bounded = createHttpFetch(proxy, { headersTimeoutMs: 100, bodyTimeoutMs: 100 });
  const unbounded = createHttpFetch(proxy, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
  assert.notEqual(bounded, unbounded); assert.equal(unbounded.transportOptions.headersTimeoutMs, 0); assert.equal(unbounded.transportOptions.bodyTimeoutMs, 0);
  assert.equal(createHttpFetch(proxy, { headersTimeoutMs: 0, bodyTimeoutMs: 0 }), unbounded);
  await Promise.all([
    assert.rejects(() => bounded(endpoint), (error) => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'),
    assert.rejects(async () => (await bounded(`${endpoint}/body`)).text(), (error) => error.cause?.code === 'UND_ERR_BODY_TIMEOUT'),
    (async () => { assert.equal(await (await unbounded(endpoint)).text(), 'done'); })(),
    (async () => { assert.equal(await (await unbounded(`${endpoint}/body`)).text(), 'startdone'); })(),
  ]);
});

test('sandbox records only explicit Ollama duration numbers with nanosecond units', async () => {
  const data = { message: { content: 'ok' }, done: true, done_reason: 'stop', total_duration: 1_500_000, load_duration: 500_000, prompt_eval_duration: 300_000, eval_duration: 700_000, secret_duration: 'PRIVATE', prompt_eval_count: 1, eval_count: 2 };
  const result = await executeSandboxRequest(args({ provider: 'ollama', body: { stream: false }, fetch: fakeResponse(JSON.stringify(data), 'application/json') }));
  assert.deepEqual(result.providerMetrics, { totalDurationNs: 1_500_000, loadDurationNs: 500_000, promptEvalDurationNs: 300_000, evalDurationNs: 700_000 });
  assert.equal(result.metrics.firstContentMs, result.metrics.lastContentMs); assert.equal(result.metrics.lastActivityMs, result.metrics.lastContentMs);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('sandbox intermediate usage cannot settle an interrupted request', async () => {
  const wire = sse({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }], usage });
  const result = await executeSandboxRequest(args({ fetch: fakeResponse(wire) }));
  assert.equal(result.executionResolved, false); assert.equal(result.usageKnown, false); assert.equal(result.usage, null);
});
