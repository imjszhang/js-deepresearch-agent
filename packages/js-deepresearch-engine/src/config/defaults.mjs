import { normalizeSearchConfig } from '../search/normalize-search-config.mjs';

export const defaultSettings = Object.freeze({
  llm: {
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    temperature: 0.2,
    maxTokens: 4000,
  },
  search: {
    engine: 'searxng',
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: '',
    maxResults: 8,
    language: 'en',
    safeSearch: true,
    options: {},
  },
  research: {
    strategy: 'source-based',
    iterations: 2,
    questionsPerIteration: 3,
    concurrency: 2,
    workDir: 'work_dir',
    budget: {
      maxLlmTokens: 0,
      maxSearchRequests: 0,
      maxSourceReads: 0,
      maxEstimatedCost: 0,
      reserveReportTokens: 1200,
    },
    sourceBased: {
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
      adaptiveControl: {
        enabled: false,
        minIterations: 1,
        maxIterations: 4,
        earlyStop: true,
        continueOnCriticalGaps: true,
        runtimeGateMode: 'rules',
      },
      queryMemory: {
        enabled: false,
        semanticDedup: false,
        similarityThreshold: 0.86,
      },
      sourceSelection: {
        enabled: false,
        maxPerHostname: 2,
        clusterResults: false,
        expandPageLinks: false,
        maxExpandedLinksPerPage: 5,
      },
      evidencePassages: {
        enabled: false,
        maxPassagesPerSource: 5,
        maxPassageChars: 1200,
        claimAlignment: false,
      },
      preReportGate: {
        enabled: false,
        mode: 'rules',
        blockUnsupportedClaims: false,
      },
    },
    adaptive: {
      maxSteps: 12,
      maxGapDepth: 2,
      maxOpenGaps: 8,
      maxQueriesPerStep: 3,
      maxReadsPerStep: 3,
      plannerParallelism: 2,
      enableCoding: false,
      gateMode: 'rules-then-llm',
    },
  },
});

export function mergeSettings(overrides = {}) {
  const searchOverrides = { ...(overrides.search || {}) };
  if (searchOverrides.baseUrl === undefined && searchOverrides.searxngUrl !== undefined) {
    searchOverrides.baseUrl = searchOverrides.searxngUrl;
  }
  delete searchOverrides.searxngUrl;

  const merged = {
    llm: { ...defaultSettings.llm, ...(overrides.llm || {}) },
    search: { ...defaultSettings.search, ...searchOverrides },
    research: {
      ...defaultSettings.research,
      ...(overrides.research || {}),
      budget: {
        ...defaultSettings.research.budget,
        ...(overrides.research?.budget || {}),
      },
      sourceBased: {
        ...defaultSettings.research.sourceBased,
        ...(overrides.research?.sourceBased || {}),
        adaptiveControl: {
          ...defaultSettings.research.sourceBased.adaptiveControl,
          ...(overrides.research?.sourceBased?.adaptiveControl || {}),
        },
        queryMemory: {
          ...defaultSettings.research.sourceBased.queryMemory,
          ...(overrides.research?.sourceBased?.queryMemory || {}),
        },
        sourceSelection: {
          ...defaultSettings.research.sourceBased.sourceSelection,
          ...(overrides.research?.sourceBased?.sourceSelection || {}),
        },
        evidencePassages: {
          ...defaultSettings.research.sourceBased.evidencePassages,
          ...(overrides.research?.sourceBased?.evidencePassages || {}),
        },
        preReportGate: {
          ...defaultSettings.research.sourceBased.preReportGate,
          ...(overrides.research?.sourceBased?.preReportGate || {}),
        },
      },
      adaptive: {
        ...defaultSettings.research.adaptive,
        ...(overrides.research?.adaptive || {}),
      },
    },
  };

  merged.search = normalizeSearchConfig(merged.search);
  return merged;
}
