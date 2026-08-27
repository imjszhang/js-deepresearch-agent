export const DEFAULT_FANOUT_OPTIONS = Object.freeze({
  failurePolicy: 'partial',
  merge: 'round-robin',
  maxParallelBackends: 0,
});

const PUBLIC_SEARCH_KEYS_TO_OMIT = new Set(['mode', 'backends', 'fanout', 'engine']);

export function resolveSearchMode(search = {}) {
  const mode = search.mode;
  if (mode === undefined || mode === null || mode === '') return 'single';
  const normalized = String(mode).trim().toLowerCase();
  if (normalized === 'single') return 'single';
  if (normalized === 'fanout') return 'fanout';
  throw new Error(`Invalid search.mode: "${mode}". Expected "single" or "fanout".`);
}

export function parseSearchEngineList(value) {
  const items = Array.isArray(value)
    ? value.map((item) => String(item || '').trim())
    : String(value || '').split(/[,;]/).map((item) => item.trim());
  return [...new Set(items.filter(Boolean))];
}

export function buildFanoutBackendsFromEngines(engineIds, existingBackends = []) {
  const engines = parseSearchEngineList(engineIds);
  const existingByEngine = new Map();
  for (const backend of existingBackends || []) {
    if (backend?.engine && !existingByEngine.has(backend.engine)) {
      existingByEngine.set(backend.engine, backend);
    }
  }
  return engines.map((engine) => {
    const existing = existingByEngine.get(engine);
    return {
      id: existing?.id || engine,
      engine,
      enabled: true,
      settings: existing?.settings && typeof existing.settings === 'object'
        ? { ...existing.settings }
        : {},
    };
  });
}

export function resolveEnabledBackends(search = {}) {
  const backends = Array.isArray(search.backends) ? search.backends : [];
  const enabled = [];
  const seen = new Set();

  for (const [index, backend] of backends.entries()) {
    if (!backend || backend.enabled === false) continue;
    const id = String(backend.id || '').trim();
    if (!id) {
      throw new Error(`Search backend at index ${index} is missing a required id.`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate search backend id: "${id}".`);
    }
    seen.add(id);
    const engine = String(backend.engine || '').trim();
    if (!engine) {
      throw new Error(`Search backend "${id}" is missing a required engine.`);
    }
    enabled.push({
      id,
      engine,
      enabled: true,
      settings: backend.settings && typeof backend.settings === 'object' ? backend.settings : {},
    });
  }

  if (enabled.length === 0) {
    throw new Error('Fan-out search requires at least one enabled backend.');
  }

  return enabled;
}

export function resolveFanoutOptions(search = {}, enabledCount) {
  const raw = search.fanout && typeof search.fanout === 'object' ? search.fanout : {};
  const failurePolicy = raw.failurePolicy === undefined || raw.failurePolicy === ''
    ? DEFAULT_FANOUT_OPTIONS.failurePolicy
    : String(raw.failurePolicy);
  if (failurePolicy !== 'partial') {
    throw new Error(`Invalid search.fanout.failurePolicy: "${raw.failurePolicy}". Expected "partial".`);
  }

  const merge = raw.merge === undefined || raw.merge === ''
    ? DEFAULT_FANOUT_OPTIONS.merge
    : String(raw.merge);
  if (merge !== 'round-robin') {
    throw new Error(`Invalid search.fanout.merge: "${raw.merge}". Expected "round-robin".`);
  }

  const parallelRaw = raw.maxParallelBackends;
  let maxParallelBackends;
  if (parallelRaw === undefined || parallelRaw === null || parallelRaw === '') {
    maxParallelBackends = enabledCount;
  } else {
    const number = Number(parallelRaw);
    if (!Number.isFinite(number) || number !== Math.floor(number) || number < 0) {
      throw new Error('Invalid search.fanout.maxParallelBackends: expected a positive integer or 0 for all backends.');
    }
    maxParallelBackends = number === 0 ? enabledCount : number;
  }

  if (!Number.isFinite(maxParallelBackends) || maxParallelBackends < 1) {
    throw new Error('Invalid search.fanout.maxParallelBackends: expected a positive integer or 0 for all backends.');
  }

  return {
    failurePolicy,
    merge,
    maxParallelBackends: Math.floor(maxParallelBackends),
  };
}

export function mergeBackendSettings(topSearch = {}, backend = {}) {
  const publicSettings = {};
  for (const [key, value] of Object.entries(topSearch || {})) {
    if (PUBLIC_SEARCH_KEYS_TO_OMIT.has(key)) continue;
    publicSettings[key] = value;
  }
  const settings = backend.settings && typeof backend.settings === 'object' ? backend.settings : {};
  return {
    ...publicSettings,
    ...settings,
    engine: backend.engine,
    provider: {
      ...(publicSettings.provider && typeof publicSettings.provider === 'object' ? publicSettings.provider : {}),
      ...(settings.provider && typeof settings.provider === 'object' ? settings.provider : {}),
    },
    options: {
      ...(publicSettings.options && typeof publicSettings.options === 'object' ? publicSettings.options : {}),
      ...(settings.options && typeof settings.options === 'object' ? settings.options : {}),
    },
  };
}

export function resolveSearchMaxResults(search = {}, fallback = 8) {
  const number = Number(search?.maxResults);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}
