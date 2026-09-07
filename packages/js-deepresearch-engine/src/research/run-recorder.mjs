import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_FAILURE_PHASES,
  sanitizeReportFailedChecks,
} from './report-builder.mjs';

export const RUN_RECORD_SCHEMA_VERSION = 1;

const LARGE_STRING_BLOB_THRESHOLD = 2048;
const BLOB_REFERENCE_KEY = '$jdrBlob';
const SECRET_KEY = /(?:^token$|api[-_]?key|authorization|cookie|set-cookie|password|passwd|secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|session[-_]?token|client[-_]?secret|proxy[-_]?authorization)/i;
const REASONING_KEY = /^(?:reasoning(?:_?content|_?details|_?text)?|analysis|thinking|chain_?of_?thought)$/i;

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_KEY.test(name)) parsed.searchParams.set(name, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactSecretsInText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(
      /\b((?:openai|jina|anthropic|search)?_?api_?key|access_?token|refresh_?token|client_?secret)\s*[:=]\s*([^\s,;&"'<>)\]}]+)/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b((?:https?|socks5h?|socks):\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      '$1',
    );
}

export function sanitizeRecordedValue(value, key = '', options = {}) {
  const scrubText = options.scrubText !== false;
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (REASONING_KEY.test(key)) return undefined;
  if (typeof value === 'string') {
    const redacted = scrubText ? redactSecretsInText(value) : value;
    return /(?:url|endpoint|proxy)/i.test(key) ? redactUrl(redacted) : redacted;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeRecordedValue(item, '', options))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      code: value.code || null,
    };
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([entryKey, entryValue]) => [
      sanitizeRecordedValue(entryKey, '', options),
      sanitizeRecordedValue(entryValue, '', options),
    ]);
  }
  if (value instanceof Set) {
    return [...value.values()].map((item) => sanitizeRecordedValue(item, '', options));
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeRecordedValue(childValue, childKey, options);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

// LLM payloads skip free-text scrubbing so a recorded request replays the same bytes
// that were sent; credentials never reach the body and stay covered by SECRET_KEY.
function payloadFidelity(kind) {
  return kind === 'llm' ? { scrubText: false } : {};
}

function serializeSanitized(value) {
  const serialized = JSON.stringify(value, null, 2);
  return `${serialized === undefined ? 'null' : serialized}\n`;
}

function serialize(value) {
  return serializeSanitized(sanitizeRecordedValue(value));
}

function recordBody(value, sanitized) {
  if (typeof value === 'string') return value;
  return sanitized ? serializeSanitized(value) : serialize(value);
}

function atomicWrite(file, value, { sanitized = false } = {}) {
  ensurePrivateDirectory(path.dirname(file));
  const existed = fs.existsSync(file);
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const body = recordBody(value, sanitized);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    if (!existed) {
      try {
        const directoryFd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch { /* directory fsync is unavailable on some platforms */ }
    }
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* retain original error */ }
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function appendJsonLine(file, entry, { sanitized = false } = {}) {
  ensurePrivateDirectory(path.dirname(file));
  const line = `${JSON.stringify(sanitized ? entry : sanitizeRecordedValue(entry))}\n`;
  const buffer = Buffer.from(line, 'utf8');
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error(`Failed to append a journal record to ${file}.`);
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function safeName(value, fallback = 'record') {
  const normalized = String(value || fallback)
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function errorRecord(error) {
  if (!error) return null;
  const normalized = error instanceof Error ? error : new Error(String(error));
  const phase = REPORT_FAILURE_PHASES.includes(normalized.phase) ? normalized.phase : null;
  return sanitizeRecordedValue({
    name: normalized.name || 'Error',
    message: normalized.message || String(normalized),
    code: normalized.code || null,
    phase,
    failedChecks: sanitizeReportFailedChecks(normalized.failedChecks, { phase }),
    attemptCounts: normalized.attemptCounts || null,
    cause: normalized.cause ? {
      name: normalized.cause.name || 'Error',
      message: normalized.cause.message || String(normalized.cause),
      code: normalized.cause.code || null,
    } : null,
  });
}

function externalizeLargeStrings(value, writeTextBlob) {
  if (typeof value === 'string' && value.length >= LARGE_STRING_BLOB_THRESHOLD) {
    return { [BLOB_REFERENCE_KEY]: writeTextBlob(value) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => externalizeLargeStrings(item, writeTextBlob));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      externalizeLargeStrings(child, writeTextBlob),
    ]),
  );
}

export class FileRunRecorder {
  constructor({ sessionDir, runId, strategy, query, metadata = {}, reopen = false } = {}) {
    if (!sessionDir) throw new Error('sessionDir is required for FileRunRecorder.');
    this.sessionDir = path.resolve(sessionDir);
    this.eventsPath = path.join(this.sessionDir, 'journal', 'events.jsonl');
    this.runPath = path.join(this.sessionDir, 'run.json');
    this.callsDir = path.join(this.sessionDir, 'calls');
    this.checkpointsDir = path.join(this.sessionDir, 'checkpoints');
    this.blobsDir = path.join(this.sessionDir, 'blobs');
    this.sequence = 0;
    this.checkpointSequence = 0;
    for (const dir of [this.sessionDir, path.dirname(this.eventsPath), this.callsDir, this.checkpointsDir, this.blobsDir]) {
      ensurePrivateDirectory(dir);
    }
    if (reopen) {
      this.#reopenExisting();
      return;
    }
    this.run = {
      ...sanitizeRecordedValue(metadata),
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: runId || null,
      strategy: strategy || null,
      query: query || '',
      status: 'running',
      latestCheckpoint: null,
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.runPath, this.run, { sanitized: true });
    this.event('session_started', {
      runId: this.run.runId,
      strategy: this.run.strategy,
    });
  }

  static reopen(sessionDir) {
    return new FileRunRecorder({ sessionDir, reopen: true });
  }

  #reopenExisting() {
    if (!fs.existsSync(this.runPath)) {
      throw new Error(`Cannot reopen session without run.json: ${this.sessionDir}`);
    }
    const existing = JSON.parse(fs.readFileSync(this.runPath, 'utf8'));
    this.sequence = lastJournalSequence(this.eventsPath);
    this.checkpointSequence = lastCheckpointSequence(this.checkpointsDir);
    this.run = {
      ...existing,
      status: 'running',
      error: null,
      phase: null,
      failedChecks: [],
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.runPath, this.run, { sanitized: true });
    this.event('session_resumed', {
      runId: this.run.runId,
      strategy: this.run.strategy,
      fromCheckpoint: existing.latestCheckpoint || null,
    });
  }

  event(type, payload = {}) {
    const seq = ++this.sequence;
    const sanitizedPayload = sanitizeRecordedValue(payload) || {};
    const entry = {
      ...this.#externalize(sanitizedPayload),
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      seq,
      type: safeName(type, 'event'),
      operationId: sanitizedPayload.operationId
        || sanitizedPayload.callId
        || `event-${String(seq).padStart(8, '0')}`,
      parentOperationId: sanitizedPayload.parentOperationId || null,
      createdAt: new Date().toISOString(),
    };
    appendJsonLine(this.eventsPath, entry, { sanitized: true });
    return entry;
  }

  writeBlob(value, { mediaType = 'application/json', sanitized = false } = {}) {
    const prepared = sanitized ? value : sanitizeRecordedValue(value);
    const body = mediaType === 'text/plain'
      ? String(prepared ?? '')
      : serializeSanitized(prepared);
    return this.#writeBlobBody(body, mediaType);
  }

  #externalize(sanitizedValue) {
    return externalizeLargeStrings(
      sanitizedValue,
      (text) => this.#writeBlobBody(text, 'text/plain'),
    );
  }

  #writeBlobBody(body, mediaType) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const extension = mediaType === 'text/plain' ? 'txt' : 'json';
    const file = path.join(this.blobsDir, `${hash}.${extension}`);
    if (!fs.existsSync(file)) atomicWrite(file, body);
    return {
      sha256: hash,
      mediaType,
      bytes: Buffer.byteLength(body),
      path: path.relative(this.sessionDir, file),
    };
  }

  checkpoint(boundary, state, metadata = {}) {
    const checkpointId = String(++this.checkpointSequence).padStart(6, '0');
    const externalizedState = this.#externalize(sanitizeRecordedValue(state));
    const stateBlob = this.writeBlob(externalizedState, { sanitized: true });
    const record = {
      ...sanitizeRecordedValue(metadata),
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      checkpointId,
      boundary: safeName(boundary, 'checkpoint'),
      eventSeq: this.sequence,
      state: stateBlob,
      createdAt: new Date().toISOString(),
    };
    const file = path.join(
      this.checkpointsDir,
      `${checkpointId}-${record.boundary}.json`,
    );
    atomicWrite(file, record, { sanitized: true });
    atomicWrite(path.join(this.checkpointsDir, 'latest.json'), {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      checkpointId,
      boundary: record.boundary,
      checkpointPath: path.relative(this.sessionDir, file),
      state: stateBlob,
      createdAt: record.createdAt,
    }, { sanitized: true });
    this.run.latestCheckpoint = path.relative(this.sessionDir, file);
    this.run.updatedAt = record.createdAt;
    atomicWrite(this.runPath, this.run, { sanitized: true });
    this.event('checkpoint_committed', {
      checkpointId,
      boundary: record.boundary,
      checkpointPath: this.run.latestCheckpoint,
      state: stateBlob,
    });
    return record;
  }

  callStarted({ callId, kind, request, ...metadata } = {}) {
    const id = safeName(callId, `call-${this.sequence + 1}`);
    const normalizedKind = safeName(kind, 'external');
    const record = {
      ...sanitizeRecordedValue(metadata),
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      callId: id,
      kind: normalizedKind,
      status: 'in_flight',
      request: sanitizeRecordedValue(request, '', payloadFidelity(normalizedKind)),
      startedAt: new Date().toISOString(),
    };
    const file = path.join(this.callsDir, `${id}.request.json`);
    atomicWrite(file, record, { sanitized: true });
    this.event('external_call_started', {
      callId: id,
      kind: record.kind,
      recordPath: path.relative(this.sessionDir, file),
    });
    return record;
  }

  callFinished({ callId, kind, response, error, status, ...metadata } = {}) {
    const id = safeName(callId, `call-${this.sequence + 1}`);
    const normalizedKind = safeName(kind, 'external');
    const failed = Boolean(error) || status === 'failed' || status === 'cancelled';
    const record = {
      ...sanitizeRecordedValue(metadata),
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      callId: id,
      kind: normalizedKind,
      status: status || (failed ? 'failed' : 'completed'),
      response: response === undefined
        ? null
        : sanitizeRecordedValue(response, '', payloadFidelity(normalizedKind)),
      error: errorRecord(error),
      completedAt: new Date().toISOString(),
    };
    const suffix = failed ? 'error' : 'response';
    const file = path.join(this.callsDir, `${id}.${suffix}.json`);
    atomicWrite(file, record, { sanitized: true });
    this.event('external_call_finished', {
      callId: id,
      kind: record.kind,
      status: record.status,
      recordPath: path.relative(this.sessionDir, file),
    });
    return record;
  }

  finalize(status, { error = null, ...metadata } = {}) {
    const normalized = ['completed', 'failed', 'cancelled'].includes(status)
      ? status
      : 'failed';
    const completedAt = new Date().toISOString();
    const recordedError = errorRecord(error);
    const safeMetadata = sanitizeRecordedValue(metadata);
    const failurePath = path.join(this.sessionDir, 'failure.json');
    if (error) {
      atomicWrite(failurePath, {
        ...safeMetadata,
        schemaVersion: RUN_RECORD_SCHEMA_VERSION,
        status: normalized,
        phase: recordedError?.phase || null,
        failedChecks: recordedError?.failedChecks || [],
        error: recordedError,
        completedAt,
      }, { sanitized: true });
    } else {
      try { fs.unlinkSync(failurePath); } catch { /* no stale failure file */ }
    }
    this.event('session_finished', {
      ...safeMetadata,
      status: normalized,
      phase: recordedError?.phase || null,
      failedChecks: recordedError?.failedChecks || [],
      error: recordedError,
    });
    this.run = {
      ...this.run,
      ...safeMetadata,
      status: normalized,
      phase: recordedError?.phase || null,
      failedChecks: recordedError?.failedChecks || [],
      error: recordedError,
      completedAt,
      updatedAt: completedAt,
    };
    atomicWrite(this.runPath, this.run, { sanitized: true });
    return this.run;
  }
}

export const NOOP_RUN_RECORDER = Object.freeze({
  enabled: false,
  event() {},
  writeBlob() { return null; },
  checkpoint() { return null; },
  callStarted() { return null; },
  callFinished() { return null; },
  finalize() {},
});

export function recorderOrNoop(recorder) {
  return recorder && typeof recorder === 'object' ? recorder : NOOP_RUN_RECORDER;
}

function resolveInsideSession(sessionDir, relativePath) {
  const session = path.resolve(sessionDir);
  const file = path.resolve(session, relativePath);
  if (!file.startsWith(`${session}${path.sep}`)) {
    throw new Error('Recorded artifact path escapes the session directory.');
  }
  return file;
}

function readVerifiedBlob(sessionDir, reference) {
  const file = resolveInsideSession(sessionDir, reference?.path || '');
  const body = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (hash !== reference?.sha256) {
    throw new Error(`Recorded blob hash mismatch: ${reference?.path || 'unknown'}`);
  }
  return reference.mediaType === 'text/plain'
    ? body.toString('utf8')
    : JSON.parse(body.toString('utf8'));
}

function materializeBlobReferences(value, sessionDir) {
  if (Array.isArray(value)) {
    return value.map((item) => materializeBlobReferences(item, sessionDir));
  }
  if (!value || typeof value !== 'object') return value;
  if (value[BLOB_REFERENCE_KEY]) {
    return materializeBlobReferences(
      readVerifiedBlob(sessionDir, value[BLOB_REFERENCE_KEY]),
      sessionDir,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      materializeBlobReferences(child, sessionDir),
    ]),
  );
}

function loadCheckpointRecord(sessionDir, relativePath) {
  const run = JSON.parse(fs.readFileSync(path.join(path.resolve(sessionDir), 'run.json'), 'utf8'));
  const checkpointPath = resolveInsideSession(sessionDir, relativePath);
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const statePath = resolveInsideSession(sessionDir, checkpoint.state?.path || '');
  const externalizedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(statePath))
    .digest('hex');
  if (hash !== checkpoint.state.sha256) {
    throw new Error(`Checkpoint state hash mismatch: ${checkpoint.checkpointId}`);
  }
  return {
    run,
    checkpoint,
    state: materializeBlobReferences(externalizedState, sessionDir),
  };
}

export function loadLatestCheckpoint(sessionDir) {
  const run = JSON.parse(fs.readFileSync(path.join(path.resolve(sessionDir), 'run.json'), 'utf8'));
  if (!run.latestCheckpoint) return null;
  return loadCheckpointRecord(sessionDir, run.latestCheckpoint);
}

export function loadNamedCheckpoint(sessionDir, boundary) {
  const resolved = path.resolve(sessionDir);
  const dir = path.join(resolved, 'checkpoints');
  if (!fs.existsSync(dir)) return null;
  const suffix = `-${safeName(boundary, 'checkpoint')}.json`;
  const files = fs.readdirSync(dir)
    .filter((name) => /^\d{6}-/.test(name) && name.endsWith(suffix))
    .sort();
  if (!files.length) return null;
  return loadCheckpointRecord(resolved, path.join('checkpoints', files[files.length - 1]));
}

export function maxRecordedCallSequence(sessionDir, kind = 'llm') {
  const dir = path.join(path.resolve(sessionDir), 'calls');
  if (!fs.existsSync(dir)) return 0;
  const pattern = new RegExp(`^${kind}-(\\d+)\\.(?:request|response|error)\\.json$`);
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function lastJournalSequence(eventsPath) {
  if (!fs.existsSync(eventsPath)) return 0;
  let max = 0;
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const seq = Number(JSON.parse(line).seq);
      if (Number.isFinite(seq)) max = Math.max(max, seq);
    } catch {
      /* ignore a crashed trailing line */
    }
  }
  return max;
}

function lastCheckpointSequence(checkpointsDir) {
  if (!fs.existsSync(checkpointsDir)) return 0;
  let max = 0;
  for (const name of fs.readdirSync(checkpointsDir)) {
    const match = name.match(/^(\d{6})-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export function readEventJournal(sessionDir, { materializeBlobs = false } = {}) {
  const file = path.join(path.resolve(sessionDir), 'journal', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]);
      events.push(materializeBlobs ? materializeBlobReferences(entry, sessionDir) : entry);
    } catch (error) {
      const isTrailingRecord = lines.slice(index + 1).every((line) => !line.trim());
      if (!isTrailingRecord) throw error;
    }
  }
  return events;
}
