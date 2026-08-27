import { SearxngSearchEngine } from './engines/searxng.mjs';
import { createFanoutSearchEngine } from './fanout-engine.mjs';
import { resolveSearchMode } from './fanout-config.mjs';
import { normalizeSearchConfig } from './normalize-search-config.mjs';

const searchEngines = new Map();

const BUILTIN_SEARCH_ENGINES = [
  {
    id: 'searxng',
    metadata: {
      label: 'SearXNG',
      supportsBaseUrl: true,
    },
    create: (config) => new SearxngSearchEngine(normalizeSearchConfig(config)),
  },
];

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

function registerBuiltins() {
  for (const engine of BUILTIN_SEARCH_ENGINES) {
    registerSearchEngine(engine.id, {
      create: engine.create,
      metadata: engine.metadata,
    });
  }
}

export function resetSearchEngines() {
  searchEngines.clear();
  registerBuiltins();
}

export function createSearchEngine(settings) {
  const search = normalizeSearchConfig(settings?.search || {});
  const mode = resolveSearchMode(search);
  if (mode === 'fanout') {
    return createFanoutSearchEngine(search, instantiateRegisteredEngine);
  }

  const engineId = search.engine;
  const entry = searchEngines.get(engineId);
  if (!entry?.create) {
    throw new Error(`Unsupported search engine for MVP: ${engineId}`);
  }
  return assignEngineId(entry.create(normalizeSearchConfig(search)), engineId);
}

function instantiateRegisteredEngine(engineId, config, backendId) {
  const entry = searchEngines.get(engineId);
  if (!entry?.create) {
    throw new Error(`Unknown search backend engine "${engineId}" for backend "${backendId}".`);
  }
  return assignEngineId(entry.create(normalizeSearchConfig(config)), engineId);
}

function assignEngineId(instance, engineId) {
  if (instance && typeof instance === 'object' && instance.id == null) {
    instance.id = engineId;
  }
  return instance;
}

registerBuiltins();
