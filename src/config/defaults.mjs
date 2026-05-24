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
    searxngUrl: 'http://127.0.0.1:8080',
    maxResults: 8,
    language: 'en',
    safeSearch: true,
  },
  research: {
    strategy: 'source-based',
    iterations: 2,
    questionsPerIteration: 3,
    concurrency: 2,
  },
});

export function mergeSettings(overrides = {}) {
  return {
    llm: { ...defaultSettings.llm, ...(overrides.llm || {}) },
    search: { ...defaultSettings.search, ...(overrides.search || {}) },
    research: { ...defaultSettings.research, ...(overrides.research || {}) },
  };
}
