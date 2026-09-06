const TRANSPORT_MEMORY_SCHEMA_VERSION = 1;
const DEFAULT_HOST_CIRCUIT_THRESHOLD = 3;
const CIRCUIT_HTTP_STATUSES = new Set([403, 429]);
const CIRCUIT_ERROR_TYPES = new Set(['challenge', 'http_403', 'http_429']);

function canonicalUrl(value = '') {
  try {
    const parsed = new URL(String(value));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(value || '').trim();
  }
}

function hostnameOf(value = '') {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeBackend(value = '') {
  return String(value || 'unknown').trim().toLowerCase() || 'unknown';
}

function normalizeRetrievalPath(value = '') {
  return String(value || 'direct').trim().toLowerCase() || 'direct';
}

function attemptKey(url, backend, retrievalPath) {
  return [canonicalUrl(url), normalizeBackend(backend), normalizeRetrievalPath(retrievalPath)].join('\0');
}

function positiveThreshold(value, fallback = DEFAULT_HOST_CIRCUIT_THRESHOLD) {
  if (value === 0 || value === '0') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function refusalReason(result = {}) {
  const status = Number(result.httpStatus) || 0;
  if (CIRCUIT_HTTP_STATUSES.has(status)) return `http_${status}`;
  const errorType = String(result.errorType || '').toLowerCase();
  if (CIRCUIT_ERROR_TYPES.has(errorType)) return errorType;
  if (result.challenge === true) return 'challenge';
  return null;
}

function safeAttemptResult(result = {}) {
  return {
    status: result.status || 'failed',
    errorType: result.errorType || null,
    httpStatus: result.httpStatus ?? null,
    fetchAttempts: result.fetchAttempts ?? null,
    retryable: result.retryable === true,
    retryAfterMs: result.retryAfterMs ?? null,
    retryDelaysMs: Array.isArray(result.retryDelaysMs) ? [...result.retryDelaysMs] : [],
    timeoutStage: result.timeoutStage || null,
    timeoutPolicy: result.timeoutPolicy || null,
  };
}

export function plannerFactsFromSnapshot(snap = {}) {
  const blockedHosts = Object.entries(snap.hosts || {})
    .filter(([, state]) => state.open)
    .map(([hostname, state]) => ({
      hostname,
      reason: state.lastReason || 'host_circuit_open',
    }));
  const attemptedUrls = (snap.attempts || []).map((entry) => ({
    url: entry.url,
    backend: entry.backend,
    retrievalPath: entry.retrievalPath,
    status: entry.status,
    errorType: entry.errorType || null,
    httpStatus: entry.httpStatus ?? null,
  }));
  const exhaustedRetrievalPaths = [...new Set(
    attemptedUrls
      .filter((entry) => entry.status && entry.status !== 'ok')
      .map((entry) => `${hostnameOf(entry.url)}:${entry.retrievalPath}`),
  )];
  return {
    blockedHosts,
    attemptedUrls: attemptedUrls.slice(-24),
    exhaustedRetrievalPaths,
  };
}

export function resolveTransportMemorySettings(settings = {}) {
  const raw = settings?.research?.read?.transport || {};
  return {
    hostCircuitThreshold: positiveThreshold(
      raw.hostCircuitThreshold,
      DEFAULT_HOST_CIRCUIT_THRESHOLD,
    ),
  };
}

/**
 * Run-scoped memory for failed URL/backend/path routes and HTTP host refusal
 * circuits. Successful results are not cached. It deliberately does not
 * choose another backend or retrieval path; those orchestration decisions
 * belong to later retrieval/planner work.
 */
export class TransportMemory {
  constructor(options = {}) {
    this.hostCircuitThreshold = positiveThreshold(
      options.hostCircuitThreshold,
      DEFAULT_HOST_CIRCUIT_THRESHOLD,
    );
    this.attempts = new Map();
    this.inFlight = new Set();
    this.hosts = new Map();
    this.eventSink = null;
  }

  setEventSink(sink) {
    this.eventSink = typeof sink === 'function' ? sink : null;
    return this;
  }

  emit(type, payload = {}) {
    this.eventSink?.({
      type,
      ...payload,
      createdAt: new Date().toISOString(),
    });
  }

  check(url, { backend = 'unknown', retrievalPath = 'direct' } = {}) {
    const normalizedUrl = canonicalUrl(url);
    const normalizedBackend = normalizeBackend(backend);
    const normalizedPath = normalizeRetrievalPath(retrievalPath);
    const key = attemptKey(normalizedUrl, normalizedBackend, normalizedPath);
    const hostname = hostnameOf(normalizedUrl);
    const prior = this.attempts.get(key);
    if (prior) {
      return {
        allowed: false,
        reason: 'url_backend_already_attempted',
        url: normalizedUrl,
        hostname,
        backend: normalizedBackend,
        retrievalPath: normalizedPath,
        prior,
      };
    }
    if (this.inFlight.has(key)) {
      return {
        allowed: false,
        reason: 'url_backend_in_flight',
        url: normalizedUrl,
        hostname,
        backend: normalizedBackend,
        retrievalPath: normalizedPath,
      };
    }
    const host = this.hosts.get(hostname);
    if (normalizedBackend === 'http' && normalizedPath === 'direct' && host?.open) {
      return {
        allowed: false,
        reason: 'host_circuit_open',
        url: normalizedUrl,
        hostname,
        backend: normalizedBackend,
        retrievalPath: normalizedPath,
        circuit: { ...host },
      };
    }
    return {
      allowed: true,
      key,
      url: normalizedUrl,
      hostname,
      backend: normalizedBackend,
      retrievalPath: normalizedPath,
    };
  }

  begin(url, options = {}) {
    const decision = this.check(url, options);
    if (!decision.allowed) {
      this.emit('transport_attempt_skipped', {
        reason: decision.reason,
        url: decision.url,
        hostname: decision.hostname || hostnameOf(decision.url),
        backend: decision.backend,
        retrievalPath: decision.retrievalPath,
      });
      return decision;
    }
    this.inFlight.add(decision.key);
    return {
      ...decision,
      startedAt: new Date().toISOString(),
    };
  }

  cancel(reservation) {
    if (reservation?.key) this.inFlight.delete(reservation.key);
  }

  finish(reservation, result = {}) {
    if (!reservation?.allowed || !reservation.key) return null;
    this.inFlight.delete(reservation.key);
    const completedAt = new Date().toISOString();
    const record = {
      url: reservation.url,
      hostname: reservation.hostname,
      backend: reservation.backend,
      retrievalPath: reservation.retrievalPath,
      startedAt: reservation.startedAt,
      completedAt,
      ...safeAttemptResult(result),
    };
    this.updateHostCircuit(record);
    if (record.status !== 'ok') this.attempts.set(reservation.key, record);
    this.emit('transport_attempt_completed', record);
    return record;
  }

  updateHostCircuit(record = {}) {
    if (record.backend !== 'http' || record.retrievalPath !== 'direct' || !record.hostname) return;
    const previous = this.hosts.get(record.hostname) || {
      consecutiveRefusals: 0,
      open: false,
      openedAt: null,
      lastReason: null,
      lastAttemptedAt: null,
    };
    if (previous.open) return;
    const reason = refusalReason(record);
    const next = {
      ...previous,
      consecutiveRefusals: reason ? previous.consecutiveRefusals + 1 : 0,
      lastReason: reason,
      lastAttemptedAt: record.completedAt,
    };
    if (reason && this.hostCircuitThreshold > 0
      && next.consecutiveRefusals >= this.hostCircuitThreshold) {
      next.open = true;
      next.openedAt = record.completedAt;
    }
    this.hosts.set(record.hostname, next);
    if (!previous.open && next.open) {
      this.emit('host_circuit_opened', {
        hostname: record.hostname,
        backend: 'http',
        retrievalPath: 'direct',
        threshold: this.hostCircuitThreshold,
        consecutiveRefusals: next.consecutiveRefusals,
        reason: next.lastReason,
      });
    }
  }

  skippedResult(decision = {}) {
    return {
      status: 'skipped',
      error: decision.reason === 'host_circuit_open'
        ? `HTTP direct circuit is open for ${decision.hostname || hostnameOf(decision.url)}`
        : `Transport attempt skipped: ${decision.reason || 'blocked'}`,
      errorType: decision.reason || 'transport_memory_skip',
      httpStatus: null,
      fetchAttempts: 0,
      retryable: false,
      retryAfterMs: null,
      backend: decision.backend || 'unknown',
      retrievalPath: decision.retrievalPath || 'direct',
      transportMemorySkipped: true,
      circuit: decision.circuit || null,
    };
  }

  plannerFacts() {
    return plannerFactsFromSnapshot(this.snapshot());
  }

  isHostBlocked(url) {
    const hostname = hostnameOf(url);
    return Boolean(hostname && this.hosts.get(hostname)?.open);
  }

  snapshot() {
    return {
      schemaVersion: TRANSPORT_MEMORY_SCHEMA_VERSION,
      hostCircuitThreshold: this.hostCircuitThreshold,
      attempts: [...this.attempts.values()].map((entry) => ({ ...entry })),
      hosts: Object.fromEntries(
        [...this.hosts.entries()].map(([hostname, state]) => [hostname, { ...state }]),
      ),
    };
  }

  exportCheckpoint() {
    return this.snapshot();
  }

  restoreCheckpoint(checkpoint = {}) {
    this.hostCircuitThreshold = positiveThreshold(
      checkpoint.hostCircuitThreshold,
      this.hostCircuitThreshold,
    );
    this.attempts = new Map(
      (checkpoint.attempts || []).map((entry) => [
        attemptKey(entry.url, entry.backend, entry.retrievalPath),
        { ...entry },
      ]),
    );
    this.inFlight = new Set();
    this.hosts = new Map(
      Object.entries(checkpoint.hosts || {}).map(([hostname, state]) => [
        hostname,
        { ...state },
      ]),
    );
    return this;
  }
}

export { TRANSPORT_MEMORY_SCHEMA_VERSION };
