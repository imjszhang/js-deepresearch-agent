import { OllamaProvider } from './providers/ollama.mjs';
import { OpenAICompatibleProvider } from './providers/openai-compatible.mjs';

const llmProviders = new Map();

const BUILTIN_LLM_PROVIDERS = [
  {
    id: 'openai-compatible',
    metadata: {
      label: 'OpenAI-Compatible',
      requiresApiKey: true,
      supportsBaseUrl: true,
    },
    create: (config) => new OpenAICompatibleProvider(config),
  },
  {
    id: 'ollama',
    metadata: {
      label: 'Ollama',
      requiresApiKey: false,
      supportsBaseUrl: true,
    },
    create: (config) => new OllamaProvider(config),
  },
];

const LLM_ALIASES = {
  openrouter: 'openai-compatible',
};

const RESERVED_PROVIDER_METADATA = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    requiresApiKey: true,
    supportsBaseUrl: false,
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    requiresApiKey: true,
    supportsBaseUrl: false,
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    requiresApiKey: true,
    supportsBaseUrl: true,
    disabledReason: 'Use OpenAI-Compatible with OpenRouter base URL for now.',
  },
];

function buildProviderMetadata() {
  const registered = [...llmProviders.values()].map((entry) => ({
    id: entry.id,
    ...entry.metadata,
  }));
  const registeredIds = new Set(registered.map((entry) => entry.id));
  const reserved = RESERVED_PROVIDER_METADATA.filter((entry) => !registeredIds.has(entry.id));
  return [...registered, ...reserved];
}

export let providerMetadata = buildProviderMetadata();

export function registerLlmProvider(id, { create, metadata }) {
  if (!id || typeof id !== 'string') {
    throw new Error('LLM provider id is required.');
  }
  llmProviders.set(id, {
    id,
    create,
    metadata: metadata || {},
  });
  providerMetadata = buildProviderMetadata();
}

function registerBuiltins() {
  for (const provider of BUILTIN_LLM_PROVIDERS) {
    registerLlmProvider(provider.id, {
      create: provider.create,
      metadata: provider.metadata,
    });
  }
}

export function resetLlmProviders() {
  llmProviders.clear();
  registerBuiltins();
}

export function createLlmProvider(settings) {
  const provider = settings.llm.provider;
  const resolvedId = LLM_ALIASES[provider] || provider;
  const entry = llmProviders.get(resolvedId);
  if (!entry?.create) {
    throw new Error(`Unsupported LLM provider for MVP: ${provider}`);
  }
  return entry.create(settings.llm);
}

registerBuiltins();
