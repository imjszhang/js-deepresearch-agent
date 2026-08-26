import { positiveInteger } from './strategy-utils.mjs';

const DEFAULT_FOCUSED = Object.freeze({
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
  iterationControl: Object.freeze({
    enabled: true,
    minIterations: 1,
    maxIterations: 3,
    earlyStop: true,
    continueOnCriticalGaps: true,
    runtimeGateMode: 'rules',
  }),
  queryMemory: Object.freeze({ enabled: true, semanticDedup: false, similarityThreshold: 0.86 }),
  sourceSelection: Object.freeze({
    enabled: true,
    maxPerHostname: 2,
    clusterResults: true,
    expandPageLinks: false,
    maxExpandedLinksPerPage: 5,
  }),
  evidencePassages: Object.freeze({ enabled: true, maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true }),
  preReportGate: Object.freeze({ enabled: false, mode: 'rules', blockUnsupportedClaims: false }),
});

const VALID_FETCH_MODES = new Set(['disabled', 'full', 'summary', 'extract']);
const VALID_FETCH_BACKENDS = new Set(['auto', 'http', 'js-eyes']);

function resolveBooleanFlag(rawValue, defaultValue) {
  return rawValue === undefined ? defaultValue : rawValue === true;
}

function readFocusedRaw(settings = {}) {
  return settings?.research?.focused || settings?.research?.sourceBased || {};
}

export function resolveFocusedSettings(settings = {}) {
  const raw = readFocusedRaw(settings);
  const fetchMode = VALID_FETCH_MODES.has(raw.fetchMode) ? raw.fetchMode : DEFAULT_FOCUSED.fetchMode;
  const fetchBackend = VALID_FETCH_BACKENDS.has(raw.fetchBackend)
    ? raw.fetchBackend
    : DEFAULT_FOCUSED.fetchBackend;
  const iterationControlRaw = raw.iterationControl || raw.adaptiveControl || {};

  return {
    fetchMode,
    fetchBackend,
    maxUrlsPerIteration: positiveInteger(raw.maxUrlsPerIteration, DEFAULT_FOCUSED.maxUrlsPerIteration),
    maxUrlsTotal: positiveInteger(raw.maxUrlsTotal, DEFAULT_FOCUSED.maxUrlsTotal),
    maxContentChars: positiveInteger(raw.maxContentChars, DEFAULT_FOCUSED.maxContentChars),
    enrichConcurrency: positiveInteger(raw.enrichConcurrency, DEFAULT_FOCUSED.enrichConcurrency),
    enableRelevanceFilter: resolveBooleanFlag(raw.enableRelevanceFilter, DEFAULT_FOCUSED.enableRelevanceFilter),
    maxSourcesForReport: positiveInteger(raw.maxSourcesForReport, DEFAULT_FOCUSED.maxSourcesForReport),
    questionContextLimit: positiveInteger(raw.questionContextLimit, DEFAULT_FOCUSED.questionContextLimit),
    contextCharsPerSource: positiveInteger(raw.contextCharsPerSource, DEFAULT_FOCUSED.contextCharsPerSource),
    iterationControl: {
      ...DEFAULT_FOCUSED.iterationControl,
      ...iterationControlRaw,
      minIterations: positiveInteger(iterationControlRaw.minIterations, DEFAULT_FOCUSED.iterationControl.minIterations),
      maxIterations: positiveInteger(iterationControlRaw.maxIterations, DEFAULT_FOCUSED.iterationControl.maxIterations),
      enabled: resolveBooleanFlag(iterationControlRaw.enabled, DEFAULT_FOCUSED.iterationControl.enabled),
    },
    queryMemory: {
      ...DEFAULT_FOCUSED.queryMemory,
      ...(raw.queryMemory || {}),
      enabled: resolveBooleanFlag(raw.queryMemory?.enabled, DEFAULT_FOCUSED.queryMemory.enabled),
      semanticDedup: resolveBooleanFlag(raw.queryMemory?.semanticDedup, DEFAULT_FOCUSED.queryMemory.semanticDedup),
    },
    sourceSelection: {
      ...DEFAULT_FOCUSED.sourceSelection,
      ...(raw.sourceSelection || {}),
      enabled: resolveBooleanFlag(raw.sourceSelection?.enabled, DEFAULT_FOCUSED.sourceSelection.enabled),
      maxPerHostname: positiveInteger(raw.sourceSelection?.maxPerHostname, DEFAULT_FOCUSED.sourceSelection.maxPerHostname),
      maxExpandedLinksPerPage: positiveInteger(
        raw.sourceSelection?.maxExpandedLinksPerPage,
        DEFAULT_FOCUSED.sourceSelection.maxExpandedLinksPerPage,
      ),
    },
    evidencePassages: {
      ...DEFAULT_FOCUSED.evidencePassages,
      ...(raw.evidencePassages || {}),
      enabled: resolveBooleanFlag(raw.evidencePassages?.enabled, DEFAULT_FOCUSED.evidencePassages.enabled),
      maxPassagesPerSource: positiveInteger(raw.evidencePassages?.maxPassagesPerSource, DEFAULT_FOCUSED.evidencePassages.maxPassagesPerSource),
      maxPassageChars: positiveInteger(raw.evidencePassages?.maxPassageChars, DEFAULT_FOCUSED.evidencePassages.maxPassageChars),
      claimAlignment: resolveBooleanFlag(raw.evidencePassages?.claimAlignment, DEFAULT_FOCUSED.evidencePassages.claimAlignment),
    },
    preReportGate: {
      ...DEFAULT_FOCUSED.preReportGate,
      ...(raw.preReportGate || {}),
      enabled: resolveBooleanFlag(raw.preReportGate?.enabled, DEFAULT_FOCUSED.preReportGate.enabled),
      blockUnsupportedClaims: resolveBooleanFlag(raw.preReportGate?.blockUnsupportedClaims, DEFAULT_FOCUSED.preReportGate.blockUnsupportedClaims),
    },
  };
}

export function getSourceEvidence(source = {}) {
  return String(source.summary || source.content || source.snippet || '').trim();
}

export function focusedSourceSelection(settings) {
  return settings?.research?.focused?.sourceSelection
    || settings?.research?.sourceBased?.sourceSelection;
}
