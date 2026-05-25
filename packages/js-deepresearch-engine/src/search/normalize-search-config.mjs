export function normalizeSearchConfig(config = {}) {
  const merged = { ...config };

  if (merged.searxngUrl !== undefined) {
    if (merged.baseUrl === undefined) {
      merged.baseUrl = merged.searxngUrl;
    }
    delete merged.searxngUrl;
  }

  if (config.options && typeof config.options === 'object') {
    merged.options = {
      ...config.options,
      ...(merged.options && typeof merged.options === 'object' ? merged.options : {}),
    };
  }

  return merged;
}
