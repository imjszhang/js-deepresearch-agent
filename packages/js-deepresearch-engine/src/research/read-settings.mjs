import { positiveInteger } from './strategy-utils.mjs';

const MODES = new Set(['disabled', 'full', 'summary', 'extract']);
const SITE_QUERY_MODES = new Set(['confirmed', 'always', 'never']);

export function resolveReadSettings(settings = {}, { strategy = 'focused' } = {}) {
  const shared = settings?.research?.read || {};
  const legacyFocused = settings?.research?.focused || {};
  const strategySpecific = settings?.research?.[strategy]?.read || {};
  const raw = {
    fetchMode: legacyFocused.fetchMode,
    maxContentChars: legacyFocused.maxContentChars,
    enrichConcurrency: legacyFocused.enrichConcurrency,
    ...shared,
    ...strategySpecific,
  };
  return {
    fetchMode: MODES.has(raw.fetchMode) ? raw.fetchMode : 'summary',
    maxContentChars: positiveInteger(raw.maxContentChars, 8000),
    enrichConcurrency: positiveInteger(raw.enrichConcurrency, 2),
    sourceAssessment: {
      enabled: raw.sourceAssessment?.enabled === true,
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
