import { SearxngSearchEngine } from './engines/searxng.mjs';
import { normalizeSearchConfig } from './normalize-search-config.mjs';

const searchEngines = new Map();

const RESERVED_SEARCH_METADATA = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
];

function buildSearchEngineMetadata() {
  const registered = [...searchEngines.values()].map((entry) => ({
    id: entry.id,
    ...entry.metadata,
  }));
  const registeredIds = new Set(registered.map((entry) => entry.id));
  const reserved = RESERVED_SEARCH_METADATA.filter((entry) => !registeredIds.has(entry.id));
  return [...registered, ...reserved];
}

export let searchEngineMetadata = buildSearchEngineMetadata();

export function registerSearchEngine(id, { create, metadata }) {
  if (!id || typeof id !== 'string') {
    throw new Error('Search engine id is required.');
  }
  searchEngines.set(id, {
    id,
    create,
    metadata: metadata || {},
  });
  searchEngineMetadata = buildSearchEngineMetadata();
}

export function createSearchEngine(settings) {
  const engineId = settings.search.engine;
  const entry = searchEngines.get(engineId);
  if (!entry?.create) {
    throw new Error(`Unsupported search engine for MVP: ${engineId}`);
  }
  return entry.create(settings.search);
}

registerSearchEngine('searxng', {
  metadata: {
    label: 'SearXNG',
    supportsBaseUrl: true,
  },
  create: (config) => new SearxngSearchEngine(normalizeSearchConfig(config)),
});
