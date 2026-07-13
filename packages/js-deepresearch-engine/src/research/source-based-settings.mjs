import { positiveInteger } from './strategy-utils.mjs';

const DEFAULT_SOURCE_BASED = Object.freeze({
  fetchMode: 'summary',
  fetchBackend: 'auto',
  maxUrlsPerIteration: 8,
  maxUrlsTotal: 12,
  maxContentChars: 8000,
  enrichConcurrency: 2,
  enableRelevanceFilter: false,
  maxSourcesForReport: 30,
  questionContextLimit: 30,
  contextCharsPerSource: 500,
  adaptiveControl: Object.freeze({ enabled: true, minIterations: 1, maxIterations: 3, earlyStop: true, continueOnCriticalGaps: true, runtimeGateMode: 'rules' }),
  queryMemory: Object.freeze({ enabled: true, semanticDedup: false, similarityThreshold: 0.86 }),
  sourceSelection: Object.freeze({ enabled: true, maxPerHostname: 2, clusterResults: true, expandPageLinks: false, maxExpandedLinksPerPage: 5 }),
  evidencePassages: Object.freeze({ enabled: true, maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true }),
  preReportGate: Object.freeze({ enabled: false, mode: 'rules', blockUnsupportedClaims: false }),
});

const VALID_FETCH_MODES = new Set(['disabled', 'full', 'summary', 'extract']);
const VALID_FETCH_BACKENDS = new Set(['auto', 'http', 'js-eyes']);

function resolveBooleanFlag(rawValue, defaultValue) {
  return rawValue === undefined ? defaultValue : rawValue === true;
}

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
    enableRelevanceFilter: resolveBooleanFlag(raw.enableRelevanceFilter, DEFAULT_SOURCE_BASED.enableRelevanceFilter),
    maxSourcesForReport: positiveInteger(raw.maxSourcesForReport, DEFAULT_SOURCE_BASED.maxSourcesForReport),
    questionContextLimit: positiveInteger(raw.questionContextLimit, DEFAULT_SOURCE_BASED.questionContextLimit),
    contextCharsPerSource: positiveInteger(raw.contextCharsPerSource, DEFAULT_SOURCE_BASED.contextCharsPerSource),
    adaptiveControl: {
      ...DEFAULT_SOURCE_BASED.adaptiveControl,
      ...(raw.adaptiveControl || {}),
      minIterations: positiveInteger(raw.adaptiveControl?.minIterations, DEFAULT_SOURCE_BASED.adaptiveControl.minIterations),
      maxIterations: positiveInteger(raw.adaptiveControl?.maxIterations, DEFAULT_SOURCE_BASED.adaptiveControl.maxIterations),
      enabled: resolveBooleanFlag(raw.adaptiveControl?.enabled, DEFAULT_SOURCE_BASED.adaptiveControl.enabled),
    },
    queryMemory: {
      ...DEFAULT_SOURCE_BASED.queryMemory,
      ...(raw.queryMemory || {}),
      enabled: resolveBooleanFlag(raw.queryMemory?.enabled, DEFAULT_SOURCE_BASED.queryMemory.enabled),
      semanticDedup: resolveBooleanFlag(raw.queryMemory?.semanticDedup, DEFAULT_SOURCE_BASED.queryMemory.semanticDedup),
    },
    sourceSelection: {
      ...DEFAULT_SOURCE_BASED.sourceSelection,
      ...(raw.sourceSelection || {}),
      enabled: resolveBooleanFlag(raw.sourceSelection?.enabled, DEFAULT_SOURCE_BASED.sourceSelection.enabled),
      maxPerHostname: positiveInteger(raw.sourceSelection?.maxPerHostname, DEFAULT_SOURCE_BASED.sourceSelection.maxPerHostname),
      maxExpandedLinksPerPage: positiveInteger(raw.sourceSelection?.maxExpandedLinksPerPage, DEFAULT_SOURCE_BASED.sourceSelection.maxExpandedLinksPerPage),
    },
    evidencePassages: {
      ...DEFAULT_SOURCE_BASED.evidencePassages,
      ...(raw.evidencePassages || {}),
      enabled: resolveBooleanFlag(raw.evidencePassages?.enabled, DEFAULT_SOURCE_BASED.evidencePassages.enabled),
      maxPassagesPerSource: positiveInteger(raw.evidencePassages?.maxPassagesPerSource, DEFAULT_SOURCE_BASED.evidencePassages.maxPassagesPerSource),
      maxPassageChars: positiveInteger(raw.evidencePassages?.maxPassageChars, DEFAULT_SOURCE_BASED.evidencePassages.maxPassageChars),
      claimAlignment: resolveBooleanFlag(raw.evidencePassages?.claimAlignment, DEFAULT_SOURCE_BASED.evidencePassages.claimAlignment),
    },
    preReportGate: {
      ...DEFAULT_SOURCE_BASED.preReportGate,
      ...(raw.preReportGate || {}),
      enabled: resolveBooleanFlag(raw.preReportGate?.enabled, DEFAULT_SOURCE_BASED.preReportGate.enabled),
      blockUnsupportedClaims: resolveBooleanFlag(raw.preReportGate?.blockUnsupportedClaims, DEFAULT_SOURCE_BASED.preReportGate.blockUnsupportedClaims),
    },
  };
}

export function getSourceEvidence(source = {}) {
  return String(source.summary || source.content || source.snippet || '').trim();
}
