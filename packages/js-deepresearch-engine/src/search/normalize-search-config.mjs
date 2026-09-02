const OPTION_KEYS = Object.freeze(['engines', 'categories', 'language', 'pageno', 'safesearch']);

export function sanitizeSearchOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  if (typeof value.engines === 'string' && value.engines.trim()) {
    next.engines = value.engines.trim();
  }
  if (typeof value.categories === 'string' && value.categories.trim()) {
    next.categories = value.categories.trim();
  }
  if (typeof value.language === 'string' && value.language.trim()) {
    next.language = value.language.trim();
  }
  const page = Number(value.pageno);
  if (Number.isFinite(page) && page >= 1) {
    next.pageno = Math.floor(page);
  }
  if (value.safesearch === 0 || value.safesearch === 1 || value.safesearch === '0' || value.safesearch === '1') {
    next.safesearch = String(value.safesearch);
  }
  return Object.keys(next).length ? next : null;
}

export function resolveSearchRequestOptions(config = {}, perQuery = {}) {
  const defaults = sanitizeSearchOptions(config?.options) || {};
  const overlay = sanitizeSearchOptions(perQuery) || {};
  const next = { ...defaults, ...overlay };
  if (next.language === undefined && config?.language) {
    next.language = String(config.language).trim();
  }
  if (next.safesearch === undefined && config?.safeSearch !== undefined) {
    next.safesearch = config.safeSearch ? '1' : '0';
  }
  return next;
}

export function publicSearchOptionsSnapshot(search = {}) {
  const options = sanitizeSearchOptions(search?.options) || {};
  return {
    engine: search?.engine || null,
    language: search?.language || options.language || null,
    maxResults: Number(search?.maxResults) > 0 ? Number(search.maxResults) : null,
    options,
  };
}

export function normalizeSearchConfig(config = {}) {
  const merged = { ...config };

  if (merged.searxngUrl !== undefined) {
    if (merged.baseUrl === undefined) {
      merged.baseUrl = merged.searxngUrl;
    }
    delete merged.searxngUrl;
  }

  const incoming = {
    ...(config.options && typeof config.options === 'object' ? config.options : {}),
    ...(merged.options && typeof merged.options === 'object' ? merged.options : {}),
  };
  if (incoming.language == null && merged.language != null) {
    incoming.language = merged.language;
  }
  if (incoming.safesearch == null && merged.safeSearch !== undefined) {
    incoming.safesearch = merged.safeSearch ? '1' : '0';
  }
  merged.options = sanitizeSearchOptions(incoming) || {};
  for (const key of OPTION_KEYS) {
    if (incoming[key] !== undefined && merged.options[key] === undefined && key !== 'pageno') {
      continue;
    }
  }
  return merged;
}
