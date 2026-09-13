import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SUITES = new Set(['baseline', 'input', 'output', 'concurrency', 'structure', 'cancellation', 'stability', 'replay']);
const PROVIDERS = new Set(['openai-compatible', 'ollama']);
const DEFAULT_TIMEOUTS = Object.freeze({ queueMs: 300_000, headersMs: 900_000, firstEventMs: 900_000, idleMs: 120_000, totalMs: 1_800_000 });
export const MAX_SANDBOX_PLAN_BYTES = 64 * 1024 * 1024;
export const MAX_SANDBOX_INPUT_CHARS = 32_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_REQUESTS = 10_000;
const MAX_FIXTURE_CHARS = 1_000_000;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(`Invalid sandbox plan: ${message}`);
  error.code = 'SANDBOX_PLAN_INVALID';
  throw error;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object.`);
}

function keys(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} contains an unsupported field.`);
}

function integer(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a nonempty string of at most ${max} characters.`);
}

function identifier(value, name) {
  text(value, name, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)) fail(`${name} is not a safe identifier.`);
}

function normalizedBaseUrl(value) {
  text(value, 'baseUrl', 2048);
  let url;
  try { url = new URL(value); } catch { fail('baseUrl must be an absolute HTTP URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('baseUrl must use HTTP(S) without credentials, query parameters, or fragments.');
  }
  return url.href.replace(/\/+$/, '');
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || seen.has(value)) fail('identity requires finite, acyclic JSON values.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, item => canonical(item, seen)).join(',')}]`;
  } else {
    object(value, 'identity value');
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function assertPlanSize(value) {
  const stack = [{ value, depth: 0 }], seen = new Set();
  let bytes = 0, nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { seen.delete(item.value); continue; }
    if (++nodes > 250_000 || item.depth > 32) fail('plan nesting or entry count exceeds the size bound.');
    if (typeof item.value === 'string') {
      if (item.value.length > MAX_SANDBOX_PLAN_BYTES) fail('plan exceeds the byte size bound.');
      bytes += Buffer.byteLength(JSON.stringify(item.value));
    } else if (item.value !== null && typeof item.value === 'object') {
      if (seen.has(item.value)) fail('plan cannot contain cyclic object references.');
      seen.add(item.value);
      stack.push({ value: item.value, exit: true });
      bytes += 2;
      for (const [key, child] of Object.entries(item.value)) {
        bytes += Array.isArray(item.value) ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
        stack.push({ value: child, depth: item.depth + 1 });
      }
    } else bytes += 32;
    if (bytes > MAX_SANDBOX_PLAN_BYTES) fail('plan exceeds the byte size bound.');
  }
}

export function readSandboxPlan(file) {
  let fd;
  try {
    fd = fs.openSync(path.resolve(file), 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SANDBOX_PLAN_BYTES) fail('plan file exceeds the byte size bound or is not a file.');
    const chunks = [], buffer = Buffer.alloc(64 * 1024);
    let bytes = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      bytes += count;
      if (bytes > MAX_SANDBOX_PLAN_BYTES) fail('plan file exceeds the byte size bound.');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return validateSandboxPlan(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error.code === 'SANDBOX_PLAN_INVALID') throw error;
    fail('plan file could not be read as valid JSON.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function planIdentity(plan) {
  object(plan, 'plan');
  assertPlanSize(plan);
  const identity = Object.fromEntries(Object.entries(plan).filter(([key]) => !['createdAt', 'hash'].includes(key)));
  return crypto.createHash('sha256').update(canonical(identity)).digest('hex');
}

function validateOracle(oracle) {
  object(oracle, 'validation');
  if (['none', 'json-object'].includes(oracle.kind)) {
    keys(oracle, ['kind'], 'validation');
  } else if (oracle.kind === 'exact-ids') {
    keys(oracle, ['kind', 'field', 'idField', 'expectedIds'], 'validation');
    identifier(oracle.field, 'validation.field');
    identifier(oracle.idField, 'validation.idField');
    if (!Array.isArray(oracle.expectedIds) || !oracle.expectedIds.length || oracle.expectedIds.length > 1000) fail('expectedIds must be a bounded nonempty array.');
    for (const id of oracle.expectedIds) text(id, 'expected ID');
    if (new Set(oracle.expectedIds).size !== oracle.expectedIds.length) fail('expectedIds must be unique.');
  } else if (oracle.kind === 'enum') {
    keys(oracle, ['kind', 'field', 'allowedValues'], 'validation');
    identifier(oracle.field, 'validation.field');
    if (!Array.isArray(oracle.allowedValues) || !oracle.allowedValues.length || oracle.allowedValues.length > 1000) fail('allowedValues must be a bounded nonempty array.');
    for (const value of oracle.allowedValues) text(value, 'enum value');
    if (new Set(oracle.allowedValues).size !== oracle.allowedValues.length) fail('allowedValues must be unique.');
  } else fail('validation kind is unsupported.');
}

function validateReplay(replay, plan, item) {
  keys(replay, ['sessionDir', 'callId', 'mode', 'requestFileHash', 'originalBodyHash', 'effectiveBodyHash', 'provider', 'model', 'endpointHash', 'overrides'], 'replay');
  text(replay.sessionDir, 'replay.sessionDir', 4096);
  if (!path.isAbsolute(replay.sessionDir)) fail('replay.sessionDir must be absolute.');
  identifier(replay.callId, 'replay.callId');
  if (!['exact', 'stream'].includes(replay.mode)) fail('replay.mode is unsupported.');
  for (const key of ['requestFileHash', 'originalBodyHash', 'effectiveBodyHash', 'endpointHash']) {
    if (!HASH.test(replay[key] || '')) fail(`replay.${key} must be a SHA-256 hash.`);
  }
  if (replay.provider !== plan.provider || replay.model !== plan.model) fail('replay identity differs from the plan.');
  if (!Array.isArray(replay.overrides) || replay.overrides.some(value => !['stream', 'stream_options.include_usage', 'stream_options', 'endpoint'].includes(value))
    || new Set(replay.overrides).size !== replay.overrides.length) fail('replay overrides are unsupported.');
  if (replay.mode === 'exact' && (replay.overrides.length || replay.originalBodyHash !== replay.effectiveBodyHash)) fail('exact replay cannot change the request body.');
  if (replay.mode === 'stream' && !item.stream) fail('stream replay must enable streaming.');
}

export function validateSandboxPlan(plan) {
  keys(plan, ['schemaVersion', 'createdAt', 'provider', 'model', 'baseUrl', 'resourceId', 'suite', 'seed', 'timeouts', 'limits', 'cases', 'hash'], 'plan');
  if (plan.schemaVersion !== 1) fail('schemaVersion must be 1.');
  if (typeof plan.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt))
    || new Date(plan.createdAt).toISOString() !== plan.createdAt) fail('createdAt must be an ISO UTC timestamp.');
  if (!PROVIDERS.has(plan.provider)) fail('provider is unsupported.');
  text(plan.model, 'model');
  if (normalizedBaseUrl(plan.baseUrl) !== plan.baseUrl) fail('baseUrl must be normalized.');
  identifier(plan.resourceId, 'resourceId');
  if (!SUITES.has(plan.suite)) fail('suite is unsupported.');
  text(plan.seed, 'seed', 1024);
  keys(plan.timeouts, Object.keys(DEFAULT_TIMEOUTS), 'timeouts');
  for (const key of Object.keys(DEFAULT_TIMEOUTS)) integer(plan.timeouts[key], `timeouts.${key}`, { max: MAX_TIMER_MS });
  keys(plan.limits, ['maxRequests', 'maxDurationMs', 'maxResponseBytes'], 'limits');
  integer(plan.limits.maxRequests, 'limits.maxRequests', { max: MAX_REQUESTS });
  integer(plan.limits.maxDurationMs, 'limits.maxDurationMs', { max: MAX_TIMER_MS });
  integer(plan.limits.maxResponseBytes, 'limits.maxResponseBytes', { max: MAX_RESPONSE_BYTES });
  if (!Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > plan.limits.maxRequests) fail('case count exceeds the request budget or is empty.');
  const ids = new Set();
  const groups = new Map();
  let previousGroup, inputChars = 0;
  for (const item of plan.cases) {
    keys(item, ['id', 'group', 'concurrency', 'warmup', 'messages', 'stream', 'maxTokens', 'temperature', 'validation', 'cancelAfterMs', 'replay'], 'case');
    identifier(item.id, 'case.id');
    identifier(item.group, 'case.group');
    if (ids.has(item.id)) fail('case IDs must be unique.');
    ids.add(item.id);
    integer(item.concurrency, 'case.concurrency', { max: plan.limits.maxRequests });
    if (groups.has(item.group) && (previousGroup !== item.group || groups.get(item.group) !== item.concurrency)) fail('groups must be contiguous and have one concurrency.');
    groups.set(item.group, item.concurrency);
    previousGroup = item.group;
    if (typeof item.warmup !== 'boolean' || typeof item.stream !== 'boolean') fail('warmup and stream must be booleans.');
    if (item.maxTokens !== undefined) integer(item.maxTokens, 'case.maxTokens', { min: 0 });
    if (typeof item.temperature !== 'number' || !Number.isFinite(item.temperature) || item.temperature < 0 || item.temperature > 2) fail('temperature must be between 0 and 2.');
    if (!Array.isArray(item.messages) || item.messages.length > 1000) fail('messages must be a bounded array.');
    if (plan.suite === 'replay') {
      if (plan.cases.length !== 1 || item.messages.length) fail('replay must have one case and must not copy recorded messages into its plan.');
      validateReplay(item.replay, plan, item);
    } else if (item.replay !== undefined || !item.messages.length) fail('non-replay cases require messages and cannot contain replay metadata.');
    for (const message of item.messages) {
      keys(message, ['role', 'content'], 'message');
      if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') fail('message role or content is invalid.');
      if (message.content.length > MAX_FIXTURE_CHARS + 4096) fail('one synthetic message exceeds the fixture size bound.');
      inputChars += message.content.length;
      if (inputChars > MAX_SANDBOX_INPUT_CHARS) fail('total synthetic input exceeds the character size bound.');
    }
    validateOracle(item.validation);
    if (item.cancelAfterMs !== undefined) {
      integer(item.cancelAfterMs, 'cancelAfterMs', { max: MAX_TIMER_MS });
      if (item.cancelAfterMs >= plan.timeouts.totalMs) fail('cancelAfterMs must precede the total deadline.');
    }
  }
  if (!HASH.test(plan.hash || '') || plan.hash !== planIdentity(plan)) fail('hash does not match the frozen plan.');
  return plan;
}

function numberList(values, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(values) || !values.length || values.length > 100) fail(`${name} must contain 1 to 100 values.`);
  for (const value of values) integer(value, name, { max });
  if (new Set(values).size !== values.length) fail(`${name} must not contain duplicates.`);
  return values;
}

function syntheticInput(seed, length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  const chunks = [];
  for (let offset = 0; offset < length; offset += 4096) {
    let chunk = '';
    for (let index = offset; index < Math.min(length, offset + 4096); index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      chunk += alphabet[state % alphabet.length];
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

export function createSandboxPlan(options = {}) {
  keys(options, ['provider', 'model', 'baseUrl', 'resourceId', 'suite', 'seed', 'createdAt', 'timeouts', 'limits', 'repetitions', 'inputChars', 'outputTokens', 'concurrencyLevels', 'maxTokens', 'temperature', 'cancelAfterMs', 'stabilityRequests'], 'options');
  if (options.timeouts !== undefined) keys(options.timeouts, Object.keys(DEFAULT_TIMEOUTS), 'timeouts');
  if (options.limits !== undefined) keys(options.limits, ['maxRequests', 'maxDurationMs', 'maxResponseBytes'], 'limits');
  if (options.seed !== undefined && typeof options.seed !== 'string' && !Number.isSafeInteger(options.seed)) fail('seed must be a string or a safe integer.');
  const suite = options.suite ?? 'baseline';
  if (!SUITES.has(suite) || suite === 'replay') fail('createSandboxPlan requires a fixed suite; replay plans use the recorded-request builder.');
  const seed = String(options.seed ?? '1');
  text(seed, 'seed', 1024);
  const repetitions = integer(options.repetitions ?? 3, 'repetitions', { max: MAX_REQUESTS });
  const maxTokens = integer(options.maxTokens ?? 0, 'maxTokens', { min: 0 });
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  for (const [key, value] of Object.entries(timeouts)) integer(value, `timeouts.${key}`, { max: MAX_TIMER_MS });
  integer(options.limits?.maxDurationMs ?? 7_200_000, 'limits.maxDurationMs', { max: MAX_TIMER_MS });
  integer(options.limits?.maxResponseBytes ?? 10_485_760, 'limits.maxResponseBytes', { max: MAX_RESPONSE_BYTES });
  if (options.cancelAfterMs !== undefined) integer(options.cancelAfterMs, 'cancelAfterMs', { max: MAX_TIMER_MS });
  const cases = [];
  let generatedChars = 0;
  function add(id, group, content, overrides = {}) {
    if (cases.length >= MAX_REQUESTS) fail('generated cases exceed the request safety bound.');
    generatedChars += content.length;
    if (generatedChars > MAX_SANDBOX_INPUT_CHARS) fail('total synthetic input exceeds the character size bound.');
    cases.push({ id, group, concurrency: 1, warmup: false, messages: [{ role: 'user', content }], stream: true,
      maxTokens, temperature: options.temperature ?? 0, validation: { kind: 'none' }, ...overrides });
  }
  const baseline = 'Reply with exactly READY, without explanation.';
  if (suite === 'baseline') {
    add('baseline-warmup', 'baseline', baseline, { warmup: true });
    for (let n = 1; n <= repetitions; n += 1) {
      add(`baseline-${n}-buffered`, 'baseline', baseline, { stream: false });
      add(`baseline-${n}-stream`, 'baseline', baseline);
    }
  } else if (suite === 'input') {
    for (const size of numberList(options.inputChars ?? [2048, 8192, 32768, 65536], 'inputChars', MAX_FIXTURE_CHARS)) {
      const content = `Read the synthetic text below, then reply with exactly READY. The fixture has ${size} characters; this is not a token count.\n${syntheticInput(`${seed}:${size}`, size)}`;
      for (let n = 1; n <= repetitions; n += 1) add(`input-${size}-${n}`, `input-${size}`, content);
    }
  } else if (suite === 'output') {
    for (const tokens of numberList(options.outputTokens ?? [128, 512, 2048], 'outputTokens')) {
      for (let n = 1; n <= repetitions; n += 1) {
        add(`output-${tokens}-${n}`, `output-${tokens}`, 'Write a long numbered list of ordinary household objects, one object per line. Continue until the output limit is reached.', { maxTokens: tokens });
      }
    }
  } else if (suite === 'concurrency') {
    for (const concurrency of numberList(options.concurrencyLevels ?? [1, 2], 'concurrencyLevels', MAX_REQUESTS)) {
      for (let n = 1; n <= repetitions * concurrency; n += 1) add(`concurrency-${concurrency}-${n}`, `concurrency-${concurrency}`, baseline, { concurrency });
    }
  } else if (suite === 'structure') {
    const fixtures = [
      ['object', 'Return only the JSON object {"status":"ready","count":3}.', { kind: 'json-object' }],
      ['ids', 'Return only a JSON object with an items array. Include exactly three objects with id values item-a, item-b, item-c, each once.', { kind: 'exact-ids', field: 'items', idField: 'id', expectedIds: ['item-a', 'item-b', 'item-c'] }],
      ['enum', 'Return only a JSON object with status equal to one of ready, blocked, unknown. Choose ready.', { kind: 'enum', field: 'status', allowedValues: ['ready', 'blocked', 'unknown'] }],
    ];
    for (const [kind, content, validation] of fixtures) {
      for (let n = 1; n <= repetitions; n += 1) add(`structure-${kind}-${n}`, `structure-${kind}`, content, { validation });
    }
  } else if (suite === 'cancellation') {
    for (let n = 1; n <= repetitions; n += 1) {
      add(`cancellation-${n}`, 'cancellation', 'Write a detailed, very long list of household objects and their uses.', { cancelAfterMs: options.cancelAfterMs ?? 1000 });
    }
  } else if (suite === 'stability') {
    const count = integer(options.stabilityRequests ?? 10, 'stabilityRequests', { max: MAX_REQUESTS });
    for (let n = 1; n <= count; n += 1) add(`stability-${n}`, 'stability', baseline);
  }
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const resourceId = options.resourceId ?? `endpoint-${crypto.createHash('sha256').update(baseUrl).digest('hex')}`;
  const plan = {
    schemaVersion: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    baseUrl,
    resourceId,
    suite,
    seed,
    timeouts,
    limits: { maxRequests: cases.length, maxDurationMs: 7_200_000, maxResponseBytes: 10_485_760, ...options.limits },
    cases,
  };
  plan.hash = planIdentity(plan);
  return validateSandboxPlan(plan);
}
