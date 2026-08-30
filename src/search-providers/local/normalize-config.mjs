import {
  DEFAULT_LOCAL_EXTENSIONS,
  DEFAULT_LOCAL_IGNORE,
  LOCAL_SEARCH_DEFAULTS,
} from './defaults.mjs';
import { parseCorpusDirList } from './paths.mjs';

function normalizeNameList(value, fallback) {
  const raw = Array.isArray(value)
    ? value
    : (value == null || value === '' ? fallback : String(value).split(/[,;\s]+/));
  const names = [];
  const seen = new Set();
  for (const entry of raw) {
    const name = String(entry || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length ? names : [...fallback];
}

export function normalizeLocalSearchConfig(config = {}) {
  const hasIncomingLocal = Boolean(
    (config.local && typeof config.local === 'object')
    || config.corpusDirs
    || config.localDirs,
  );
  const incoming = config.local && typeof config.local === 'object' ? config.local : {};
  const dirs = parseCorpusDirList(
    incoming.dirs ?? config.corpusDirs ?? config.localDirs,
  );
  const ignore = normalizeNameList(incoming.ignore ?? LOCAL_SEARCH_DEFAULTS.ignore, DEFAULT_LOCAL_IGNORE);
  const extensions = normalizeNameList(
    incoming.extensions ?? LOCAL_SEARCH_DEFAULTS.extensions,
    DEFAULT_LOCAL_EXTENSIONS,
  ).map((item) => item.replace(/^\./, '').toLowerCase());

  if (!hasIncomingLocal && dirs.length === 0) {
    return { ...config };
  }

  return {
    ...config,
    local: {
      dirs,
      ignore,
      extensions,
    },
  };
}
