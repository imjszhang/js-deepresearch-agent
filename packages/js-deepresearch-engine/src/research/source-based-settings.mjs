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
  adaptiveControl: Object.freeze({ enabled: false, minIterations: 1, maxIterations: 4, earlyStop: true, continueOnCriticalGaps: true, runtimeGateMode: 'rules' }),
  queryMemory: Object.freeze({ enabled: false, semanticDedup: false, similarityThreshold: 0.86 }),
  sourceSelection: Object.freeze({ enabled: false, maxPerHostname: 2, clusterResults: false, expandPageLinks: false, maxExpandedLinksPerPage: 5 }),
  evidencePassages: Object.freeze({ enabled: false, maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: false }),
  preReportGate: Object.freeze({ enabled: false, mode: 'rules', blockUnsupportedClaims: false }),
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
    adaptiveControl: {
      ...DEFAULT_SOURCE_BASED.adaptiveControl,
      ...(raw.adaptiveControl || {}),
      minIterations: positiveInteger(raw.adaptiveControl?.minIterations, 1),
      maxIterations: positiveInteger(raw.adaptiveControl?.maxIterations, 4),
      enabled: raw.adaptiveControl?.enabled === true,
    },
    queryMemory: {
      ...DEFAULT_SOURCE_BASED.queryMemory,
      ...(raw.queryMemory || {}),
      enabled: raw.queryMemory?.enabled === true,
      semanticDedup: raw.queryMemory?.semanticDedup === true,
    },
    sourceSelection: {
      ...DEFAULT_SOURCE_BASED.sourceSelection,
      ...(raw.sourceSelection || {}),
      enabled: raw.sourceSelection?.enabled === true,
      maxPerHostname: positiveInteger(raw.sourceSelection?.maxPerHostname, 2),
      maxExpandedLinksPerPage: positiveInteger(raw.sourceSelection?.maxExpandedLinksPerPage, 5),
    },
    evidencePassages: {
      ...DEFAULT_SOURCE_BASED.evidencePassages,
      ...(raw.evidencePassages || {}),
      enabled: raw.evidencePassages?.enabled === true,
      maxPassagesPerSource: positiveInteger(raw.evidencePassages?.maxPassagesPerSource, 5),
      maxPassageChars: positiveInteger(raw.evidencePassages?.maxPassageChars, 1200),
      claimAlignment: raw.evidencePassages?.claimAlignment === true,
    },
    preReportGate: {
      ...DEFAULT_SOURCE_BASED.preReportGate,
      ...(raw.preReportGate || {}),
      enabled: raw.preReportGate?.enabled === true,
      blockUnsupportedClaims: raw.preReportGate?.blockUnsupportedClaims === true,
    },
  };
}

export function getSourceEvidence(source = {}) {
  return String(source.summary || source.content || source.snippet || '').trim();
}
