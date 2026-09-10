const immediate = new Set(['unauthorized', 'forbidden', 'authentication_required', 'skill_not_trusted', 'invalid_configuration']);
const states = new Set(['healthy', 'suspect', 'open', 'half_open']);

export function isExecutionInterruption(error) {
  return ['SEARCH_PROVIDER_UNAVAILABLE', 'ENOSPC', 'SQLITE_FULL', 'EVIDENCE_INTEGRITY'].includes(error?.code);
}

export class SearchUnavailableError extends Error {
  constructor(health) {
    super('Search provider is unavailable. Progress is retained; check the provider before resuming.');
    this.name = 'SearchUnavailableError';
    this.code = 'SEARCH_PROVIDER_UNAVAILABLE';
    this.retryable = false;
    this.health = health;
  }
}

// Health is per adapter/channel, not per query. A successful empty SERP is healthy.
// No error-message parsing: untyped failures remain unknown call failures.
export class SearchHealth {
  constructor({ threshold = 3, snapshot, onChange = () => {} } = {}) {
    this.threshold = Math.max(1, Math.floor(Number(threshold) || 3));
    this.state = states.has(snapshot?.state) ? snapshot.state : 'healthy';
    this.failures = Math.max(0, Number(snapshot?.failures) || 0);
    this.lastFailure = snapshot?.lastFailure || null;
    this.onChange = onChange;
  }
  snapshot() { return { schemaVersion: 1, state: this.state, failures: this.failures, threshold: this.threshold, lastFailure: this.lastFailure }; }
  changed() { this.onChange(this.snapshot()); }
  assertAvailable() { if (this.state === 'open') throw new SearchUnavailableError(this.snapshot()); }
  beginProbe() { this.state = 'half_open'; this.changed(); }
  succeed() { this.state = 'healthy'; this.failures = 0; this.lastFailure = null; this.changed(); }
  fail(error) {
    if (error?.name === 'AbortError' || error?.name === 'BudgetExceededError' || isExecutionInterruption(error)) throw error;
    this.failures++;
    this.lastFailure = { code: error?.code || 'unknown_call_failure', scope: error?.failureScope || 'provider',
      phase: error?.phase || 'search_call', retryable: Boolean(error?.retryable), retryAfterMs: error?.retryAfterMs ?? null };
    this.state = this.state === 'half_open' || immediate.has(error?.code) || this.failures >= this.threshold ? 'open' : 'suspect';
    this.changed();
    if (this.state === 'open') throw new SearchUnavailableError(this.snapshot());
    throw error;
  }
}
