import { defaultSettings as engineDefaults, mergeSettings as mergeEngineSettings } from 'js-deepresearch-engine';
import { normalizeJsEyesSearchConfig } from '../search-providers/js-eyes/normalize-js-eyes-search-config.mjs';
import { JS_EYES_SEARCH_DEFAULTS } from '../search-providers/js-eyes/defaults.mjs';
import { LOCAL_SEARCH_DEFAULTS, normalizeLocalSearchConfig } from '../search-providers/local/public.mjs';

export function mergeAppSettings(overrides = {}) {
  const merged = mergeEngineSettings(overrides);
  merged.search = normalizeLocalSearchConfig(normalizeJsEyesSearchConfig(merged.search));
  return merged;
}

export const defaultAppSettings = mergeAppSettings({
  search: {
    ...engineDefaults.search,
    ...JS_EYES_SEARCH_DEFAULTS,
    local: { ...LOCAL_SEARCH_DEFAULTS },
  },
});
