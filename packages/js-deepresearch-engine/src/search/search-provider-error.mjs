export class SearchProviderError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SearchProviderError';
    this.code = extra.code || 'provider_error';
    this.retryable = Boolean(extra.retryable);
    const retryAfter = Number(extra.retryAfterMs);
    this.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    this.provider = extra.provider || null;
  }
}

export function isTransientSearchError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  if (error.code === 'rate_limited') return true;
  return error.retryable === true;
}

export function serializeSearchError(error) {
  if (!error) return null;
  if (typeof error === 'object' && error.message != null && error.name && !error.stack) {
    return {
      name: error.name,
      message: error.message,
      code: error.code || null,
      retryable: Boolean(error.retryable),
      retryAfterMs: error.retryAfterMs ?? null,
      provider: error.provider || null,
    };
  }
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null,
    retryable: Boolean(error.retryable),
    retryAfterMs: error.retryAfterMs ?? null,
    provider: error.provider || null,
  };
}

export function inferOutcomeFromError(error) {
  if (!error) return null;
  if (error.code === 'rate_limited') return 'rate_limited';
  if (error.retryable) return error.code === 'rate_limited' ? 'rate_limited' : 'provider_error';
  if (error.name === 'SearchProviderError' || error.code) return 'provider_error';
  return 'failed';
}

export function searchErrorFromProviderPayload(payload, {
  fallbackMessage = 'Search provider failed',
  provider = null,
} = {}) {
  const err = payload?.error;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    return new SearchProviderError(err.message || fallbackMessage, {
      code: err.code || err.detail?.code || 'provider_error',
      retryable: err.retryable === true || err.detail?.retryable === true,
      retryAfterMs: err.retryAfterMs ?? err.retry_after_ms ?? err.detail?.retryAfterMs,
      provider,
    });
  }
  return new SearchProviderError(
    (typeof err === 'string' && err.trim()) ? err : fallbackMessage,
    { code: 'provider_error', retryable: false, provider },
  );
}

const RELEVANCE_REJECTED = new Set([
  'entity_mismatch',
  'rerank_pending',
  'rerank_below_threshold',
  'relevance_rejected',
  'site_constraint_violation',
]);

export function classifyInvalidReason(invalid) {
  const reason = String(invalid || '').trim();
  if (['duplicate_query', 'duplicate_results', 'duplicate_batch_query'].includes(reason)) {
    return 'duplicate';
  }
  if (['rate_limited', 'provider_error'].includes(reason)) return 'transient';
  if (['max_steps', 'budget_exhausted'].includes(reason)) return 'cap';
  if (RELEVANCE_REJECTED.has(reason)) return 'relevance_rejected';
  return 'semantic';
}

export function classifySearchProgress({
  error = null,
  skipped = null,
  newUrls = 0,
  resultCount = 0,
} = {}) {
  if (isTransientSearchError(error)) return 'transient';
  if (skipped === 'duplicate_query' || skipped === 'duplicate_results') return 'duplicate';
  if (Number(newUrls) > 0 || Number(resultCount) > 0) return 'progress';
  return 'semantic_no_yield';
}
