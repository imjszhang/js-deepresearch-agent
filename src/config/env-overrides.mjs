import { normalizeSearchConfig } from 'js-deepresearch-engine';
import { parseProviderSkills } from '../search-providers/js-eyes/provider-skills.mjs';
import { normalizeJsEyesSearchConfig } from '../search-providers/js-eyes/normalize-js-eyes-search-config.mjs';

function normalizeAppSearchConfig(search) {
  return normalizeJsEyesSearchConfig(normalizeSearchConfig(search));
}

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

  const jsEyesCli = readEnv('JS_EYES_CLI');
  if (jsEyesCli) {
    search.jsEyesCli = jsEyesCli;
  }

  const jsEyesSkill = readEnv('JS_EYES_SKILL');
  if (jsEyesSkill) {
    const jsEyesSkills = parseProviderSkills(jsEyesSkill);
    search.jsEyesSkills = jsEyesSkills;
    search.jsEyesSkill = jsEyesSkills[0];
  }

  const jsEyesCommand = readEnv('JS_EYES_COMMAND');
  if (jsEyesCommand) {
    search.jsEyesCommand = jsEyesCommand;
  }

  const jsEyesServerUrl = readEnv('JS_EYES_SERVER_URL');
  if (jsEyesServerUrl) {
    search.jsEyesServerUrl = jsEyesServerUrl;
  }

  const jsEyesMaxPages = readEnv('JS_EYES_MAX_PAGES');
  if (jsEyesMaxPages) {
    search.jsEyesMaxPages = Number(jsEyesMaxPages);
  }

  const jsEyesTimeoutMs = readEnv('JS_EYES_TIMEOUT_MS');
  if (jsEyesTimeoutMs) {
    search.jsEyesTimeoutMs = Number(jsEyesTimeoutMs);
  }

  const research = {};
  const workDir = readEnv('WORK_DIR');
  if (workDir) {
    research.workDir = workDir;
  }

  const http = {};
  const httpProxy = readEnv('JDR_HTTP_PROXY');
  if (httpProxy) {
    http.proxy = httpProxy;
  }

  const rerankProvider = readEnv('JDR_RERANK_PROVIDER');
  const jinaApiKey = readEnv('JINA_API_KEY');
  const rerankModel = readEnv('JDR_RERANK_MODEL');
  const rerankBaseUrl = readEnv('JDR_RERANK_BASE_URL');
  const semanticTimeout = readEnv('JDR_SEMANTIC_TIMEOUT_MS');
  const embeddingProvider = readEnv('JDR_EMBEDDING_PROVIDER');
  const embeddingModel = readEnv('JDR_EMBEDDING_MODEL');
  const embeddingBaseUrl = readEnv('JDR_EMBEDDING_BASE_URL');
  const embeddingApiKey = readEnv('JDR_EMBEDDING_API_KEY') || readEnv('OPENCLAW_GATEWAY_TOKEN');
  if (rerankProvider || jinaApiKey || rerankModel || rerankBaseUrl || semanticTimeout
    || embeddingProvider || embeddingModel || embeddingBaseUrl || embeddingApiKey) {
    research.providers = {
      ...(rerankProvider || jinaApiKey || rerankModel || rerankBaseUrl || semanticTimeout ? { rerank: {
        ...(rerankProvider ? { provider: rerankProvider } : {}),
        ...(jinaApiKey ? { apiKey: jinaApiKey } : {}),
        ...(rerankModel ? { model: rerankModel } : {}),
        ...(rerankBaseUrl ? { baseUrl: rerankBaseUrl } : {}),
        ...(semanticTimeout ? { timeoutMs: Number(semanticTimeout) } : {}),
      } } : {}),
      ...(embeddingProvider || embeddingModel || embeddingBaseUrl || embeddingApiKey ? { embedding: {
        ...(embeddingProvider ? { provider: embeddingProvider } : {}),
        ...(embeddingModel ? { model: embeddingModel } : {}),
        ...(embeddingBaseUrl ? { baseUrl: embeddingBaseUrl } : {}),
        ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
        ...(semanticTimeout ? { timeoutMs: Number(semanticTimeout) } : {}),
      } } : {}),
    };
  }

  return {
    ...(Object.keys(http).length ? { http } : {}),
    ...(Object.keys(llm).length ? { llm } : {}),
    ...(Object.keys(search).length ? { search: normalizeAppSearchConfig(search) } : {}),
    ...(Object.keys(research).length ? { research } : {}),
  };
}
