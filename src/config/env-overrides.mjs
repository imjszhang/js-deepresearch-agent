export function settingsFromEnv(env = process.env) {
  function readEnv(name) {
    const value = env[name];
    if (value === undefined || value === '') {
      return undefined;
    }
    return value;
  }

  const llm = {};
  const search = {};

  const provider = readEnv('LLM_PROVIDER');
  if (provider) {
    llm.provider = provider;
  }

  const model = readEnv('LLM_MODEL');
  if (model) {
    llm.model = model;
  }

  const openAiApiKey = readEnv('OPENAI_API_KEY');
  if (openAiApiKey) {
    llm.apiKey = openAiApiKey;
  }

  const openAiBaseUrl = readEnv('OPENAI_BASE_URL');
  if (openAiBaseUrl) {
    llm.baseUrl = openAiBaseUrl;
  }

  const ollamaBaseUrl = readEnv('OLLAMA_BASE_URL');
  if (ollamaBaseUrl && (provider === 'ollama' || !openAiBaseUrl)) {
    llm.baseUrl = ollamaBaseUrl;
  }

  const searchEngine = readEnv('SEARCH_ENGINE');
  if (searchEngine) {
    search.engine = searchEngine;
  }

  const searchBaseUrl = readEnv('SEARCH_BASE_URL') || readEnv('SEARXNG_URL');
  if (searchBaseUrl) {
    search.baseUrl = searchBaseUrl;
  }

  const searchApiKey = readEnv('SEARCH_API_KEY');
  if (searchApiKey) {
    search.apiKey = searchApiKey;
  }

  return {
    ...(Object.keys(llm).length ? { llm } : {}),
    ...(Object.keys(search).length ? { search } : {}),
  };
}
