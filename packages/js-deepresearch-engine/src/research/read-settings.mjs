import { positiveInteger } from './strategy-utils.mjs';

const MODES = new Set(['disabled', 'full', 'summary', 'extract']);
const SITE_QUERY_MODES = new Set(['confirmed', 'always', 'never']);

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveReadSettings(settings = {}, { strategy = 'focused' } = {}) {
  const shared = settings?.research?.read || {};
  const legacyFocused = settings?.research?.focused || {};
  const strategySpecific = settings?.research?.[strategy]?.read || {};
  const raw = {
    fetchMode: legacyFocused.fetchMode,
    maxContentChars: legacyFocused.maxContentChars,
    maxFetchChars: legacyFocused.maxFetchChars,
    enrichConcurrency: legacyFocused.enrichConcurrency,
    ...shared,
    ...strategySpecific,
  };
  const maxContentChars = positiveInteger(raw.maxContentChars, 8000);
  return {
    fetchMode: MODES.has(raw.fetchMode) ? raw.fetchMode : 'summary',
    maxContentChars,
    maxFetchChars: Math.max(maxContentChars, positiveInteger(raw.maxFetchChars, 64000)),
    enrichConcurrency: positiveInteger(raw.enrichConcurrency, 2),
    sourceAssessment: {
      enabled: raw.sourceAssessment?.enabled === true,
    },
    alternateEvidence: {
      enabled: raw.alternateEvidence?.enabled !== false,
    },
    backends: Array.isArray(raw.backends) && raw.backends.length
      ? raw.backends.map((item) => String(item))
      : ['http', 'alternate', 'headless', 'js-eyes'],
    headless: {
      enabled: raw.headless?.enabled === true,
      waitUntil: raw.headless?.waitUntil || 'domcontentloaded',
      timeoutMs: Number(raw.headless?.timeoutMs) > 0 ? Number(raw.headless.timeoutMs) : 15000,
      maxConcurrency: Number(raw.headless?.maxConcurrency) > 0 ? Number(raw.headless.maxConcurrency) : 2,
    },
    transport: {
      maxAttempts: positiveInteger(raw.transport?.maxAttempts, 3),
      hostCircuitThreshold: nonNegativeInteger(raw.transport?.hostCircuitThreshold, 3),
      responseHeadersTimeoutMs: positiveInteger(raw.transport?.responseHeadersTimeoutMs, 10000),
      htmlTotalTimeoutMs: positiveInteger(raw.transport?.htmlTotalTimeoutMs, 15000),
      documentTotalTimeoutMs: positiveInteger(raw.transport?.documentTotalTimeoutMs, 60000),
      largeFileThresholdBytes: positiveInteger(raw.transport?.largeFileThresholdBytes, 5242880),
    },
    relevance: {
      enabled: raw.relevance?.enabled !== false,
      siteConstraint: raw.relevance?.siteConstraint !== false,
      entityGuard: raw.relevance?.entityGuard !== false,
      bodyValidation: raw.relevance?.bodyValidation !== false,
      minRerankScore: Number.isFinite(Number(raw.relevance?.minRerankScore))
        ? Number(raw.relevance.minRerankScore)
        : 0.01,
      siteQueryMode: SITE_QUERY_MODES.has(raw.relevance?.siteQueryMode)
        ? raw.relevance.siteQueryMode
        : 'confirmed',
    },
  };
}
