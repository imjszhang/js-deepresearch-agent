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
      sourceBased: {
        ...defaultSettings.research.sourceBased,
        ...(overrides.research?.sourceBased || {}),
      },
    },
  };

  merged.search = normalizeSearchConfig(merged.search);
  return merged;
}
