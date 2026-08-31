import { positiveInteger } from './strategy-utils.mjs';

const MODES = new Set(['disabled', 'full', 'summary', 'extract']);

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
  };
}
