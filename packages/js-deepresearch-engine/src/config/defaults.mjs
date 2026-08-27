import { normalizeSearchConfig } from '../search/normalize-search-config.mjs';
import { migrateResearchSettings } from '../research/strategy-aliases.mjs';

export const defaultSettings = Object.freeze({
  http: {
    proxy: '',
  },
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
    fanout: {
      failurePolicy: 'partial',
      merge: 'round-robin',
      maxParallelBackends: 0,
    },
  },
  research: {
    strategy: 'focused',
    iterations: 2,
    questionsPerIteration: 2,
    concurrency: 1,
    workDir: 'work_dir',
    reportValidation: {
      minChars: 200,
      maxAttempts: 2,
    },
    report: {
      maxOutputTokens: 0,
      maxAttempts: 2,
    },
    quality: {
      entailment: 'rules_then_llm',
    },
    budget: {
      maxLlmTokens: 0,
      maxTotalLlmTokens: 0,
      maxSearchRequests: 18,
      maxSearchBackendRequests: 0,
      maxSourceReads: 16,
      maxRerankRequests: 0,
      maxRerankTokens: 0,
      maxEstimatedCost: 0,
      reserveReportTokens: 0,
    },
    providers: {
      embedding: {
        provider: 'disabled',
        model: 'openclaw/default',
        baseUrl: 'http://127.0.0.1:18789',
        apiKey: '',
        batchSize: 64,
        timeoutMs: 60000,
      },
      rerank: {
        provider: 'rules',
        model: 'unicode-token-overlap-v1',
        baseUrl: 'https://api.jina.ai/v1',
        apiKey: '',
        batchSize: 100,
        timeoutMs: 30000,
      },
    },
    focused: {
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
      iterationControl: {
        enabled: true,
        minIterations: 1,
        maxIterations: 3,
        earlyStop: true,
        continueOnCriticalGaps: true,
        runtimeGateMode: 'rules',
      },
      queryMemory: {
        enabled: true,
        semanticDedup: false,
        similarityThreshold: 0.86,
      },
      sourceSelection: {
        enabled: true,
        maxPerHostname: 2,
        clusterResults: true,
        expandPageLinks: false,
        maxExpandedLinksPerPage: 5,
      },
      evidencePassages: {
        enabled: true,
        maxPassagesPerSource: 5,
        maxPassageChars: 1200,
        claimAlignment: true,
      },
      preReportGate: {
        enabled: false,
        mode: 'rules',
        blockUnsupportedClaims: false,
      },
    },
    exploratory: {
      maxSteps: 0,
      minLlmTokens: 20000,
      maxLlmTokens: 80000,
      targetLlmTokens: 20000,
      maxGapDepth: 2,
      maxOpenGaps: 8,
      maxQueriesPerStep: 3,
      maxReadsPerStep: 4,
      maxSearchRequests: 0,
      maxSourceReads: 0,
      plannerParallelism: 2,
      enableCoding: false,
      gateMode: 'rules-then-llm',
      maxEvaluationRetries: 1,
      answerGate: true,
    },
  },
});

export function mergeSettings(overrides = {}) {
  const searchOverrides = { ...(overrides.search || {}) };
  if (searchOverrides.baseUrl === undefined && searchOverrides.searxngUrl !== undefined) {
    searchOverrides.baseUrl = searchOverrides.searxngUrl;
  }
  delete searchOverrides.searxngUrl;

  const researchOverrides = migrateResearchSettings(overrides.research || {});

  const merged = {
    http: { ...defaultSettings.http, ...(overrides.http || {}) },
    llm: { ...defaultSettings.llm, ...(overrides.llm || {}) },
    search: {
      ...defaultSettings.search,
      ...searchOverrides,
      fanout: {
        ...defaultSettings.search.fanout,
        ...(searchOverrides.fanout && typeof searchOverrides.fanout === 'object' ? searchOverrides.fanout : {}),
      },
      ...(Array.isArray(searchOverrides.backends) ? { backends: searchOverrides.backends } : {}),
    },
    research: {
      ...defaultSettings.research,
      ...researchOverrides,
      budget: {
        ...defaultSettings.research.budget,
        ...(researchOverrides.budget || {}),
      },
      reportValidation: {
        ...defaultSettings.research.reportValidation,
        ...(researchOverrides.reportValidation || {}),
      },
      report: {
        ...defaultSettings.research.report,
        ...(researchOverrides.report || {}),
      },
      quality: {
        ...defaultSettings.research.quality,
        ...(researchOverrides.quality || {}),
      },
      providers: {
        ...defaultSettings.research.providers,
        ...(researchOverrides.providers || {}),
        embedding: {
          ...defaultSettings.research.providers.embedding,
          ...(researchOverrides.providers?.embedding || {}),
        },
        rerank: {
          ...defaultSettings.research.providers.rerank,
          ...(researchOverrides.providers?.rerank || {}),
        },
      },
      focused: {
        ...defaultSettings.research.focused,
        ...(researchOverrides.focused || {}),
        iterationControl: {
          ...defaultSettings.research.focused.iterationControl,
          ...(researchOverrides.focused?.iterationControl || {}),
        },
        queryMemory: {
          ...defaultSettings.research.focused.queryMemory,
          ...(researchOverrides.focused?.queryMemory || {}),
        },
        sourceSelection: {
          ...defaultSettings.research.focused.sourceSelection,
          ...(researchOverrides.focused?.sourceSelection || {}),
        },
        evidencePassages: {
          ...defaultSettings.research.focused.evidencePassages,
          ...(researchOverrides.focused?.evidencePassages || {}),
        },
        preReportGate: {
          ...defaultSettings.research.focused.preReportGate,
          ...(researchOverrides.focused?.preReportGate || {}),
        },
      },
      exploratory: {
        ...defaultSettings.research.exploratory,
        ...(researchOverrides.exploratory || {}),
      },
    },
  };

  delete merged.research.sourceBased;
  delete merged.research.adaptive;
  merged.search = normalizeSearchConfig(merged.search);
  return merged;
}
