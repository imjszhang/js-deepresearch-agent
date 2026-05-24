import { OllamaProvider } from './providers/ollama.mjs';
import { OpenAICompatibleProvider } from './providers/openai-compatible.mjs';

export const providerMetadata = [
  {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible',
    requiresApiKey: true,
    supportsBaseUrl: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    requiresApiKey: false,
    supportsBaseUrl: true,
  },
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

export function createLlmProvider(settings) {
  const provider = settings.llm.provider;
  if (provider === 'ollama') {
    return new OllamaProvider(settings.llm);
  }
  if (provider === 'openai-compatible' || provider === 'openrouter') {
    return new OpenAICompatibleProvider(settings.llm);
  }
  throw new Error(`Unsupported LLM provider for MVP: ${provider}`);
}
