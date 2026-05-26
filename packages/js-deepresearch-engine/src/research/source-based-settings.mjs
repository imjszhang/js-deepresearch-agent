import { positiveInteger } from './strategy-utils.mjs';

const DEFAULT_SOURCE_BASED = Object.freeze({
  fetchMode: 'disabled',
  fetchBackend: 'auto',
  maxUrlsPerIteration: 8,
  maxUrlsTotal: 24,
  maxContentChars: 8000,
  enrichConcurrency: 2,
  enableRelevanceFilter: false,
  maxSourcesForReport: 30,
  questionContextLimit: 30,
  contextCharsPerSource: 500,
});

const VALID_FETCH_MODES = new Set(['disabled', 'full', 'summary']);
const VALID_FETCH_BACKENDS = new Set(['auto', 'http', 'js-eyes']);

export function resolveSourceBasedSettings(settings = {}) {
  const raw = settings?.research?.sourceBased || {};
  const fetchMode = VALID_FETCH_MODES.has(raw.fetchMode) ? raw.fetchMode : DEFAULT_SOURCE_BASED.fetchMode;
  const fetchBackend = VALID_FETCH_BACKENDS.has(raw.fetchBackend)
    ? raw.fetchBackend
    : DEFAULT_SOURCE_BASED.fetchBackend;

  return {
    fetchMode,
    fetchBackend,
    maxUrlsPerIteration: positiveInteger(raw.maxUrlsPerIteration, DEFAULT_SOURCE_BASED.maxUrlsPerIteration),
    maxUrlsTotal: positiveInteger(raw.maxUrlsTotal, DEFAULT_SOURCE_BASED.maxUrlsTotal),
    maxContentChars: positiveInteger(raw.maxContentChars, DEFAULT_SOURCE_BASED.maxContentChars),
    enrichConcurrency: positiveInteger(raw.enrichConcurrency, DEFAULT_SOURCE_BASED.enrichConcurrency),
    enableRelevanceFilter: raw.enableRelevanceFilter === true,
    maxSourcesForReport: positiveInteger(raw.maxSourcesForReport, DEFAULT_SOURCE_BASED.maxSourcesForReport),
    questionContextLimit: positiveInteger(raw.questionContextLimit, DEFAULT_SOURCE_BASED.questionContextLimit),
    contextCharsPerSource: positiveInteger(raw.contextCharsPerSource, DEFAULT_SOURCE_BASED.contextCharsPerSource),
  };
}

export function getSourceEvidence(source = {}) {
  return String(source.summary || source.content || source.snippet || '').trim();
}
