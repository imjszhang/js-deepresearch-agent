export function availableSearchEngines(searchEngines = []) {
  return (searchEngines || []).filter((engine) => !engine.disabledReason);
}

export function selectedBackendIds(search = {}, engines = []) {
  if (search.mode === 'fanout' && Array.isArray(search.backends) && search.backends.length) {
    return search.backends
      .filter((backend) => backend && backend.enabled !== false)
      .map((backend) => backend.engine)
      .filter(Boolean);
  }
  if (search.engine) return [search.engine];
  return engines[0]?.id ? [engines[0].id] : [];
}

export function backendSettingsFor(search = {}, engineId) {
  const backend = (search.backends || []).find((item) => item?.engine === engineId || item?.id === engineId);
  return backend?.settings && typeof backend.settings === 'object' ? backend.settings : {};
}

export function buildSearchSettings({
  mode,
  engine,
  baseUrl,
  maxResults,
  maxParallelBackends,
  selectedEngines,
  backendConfigs = {},
  previous = {},
}) {
  const resolvedMode = mode === 'fanout' ? 'fanout' : 'single';
  const backends = resolvedMode === 'fanout'
    ? (selectedEngines || []).map((engineId) => {
      const previousBackend = (previous.backends || []).find((item) => item?.engine === engineId || item?.id === engineId);
      const fields = backendConfigs[engineId] || {};
      return {
        id: previousBackend?.id || engineId,
        engine: engineId,
        enabled: true,
        settings: {
          ...(previousBackend?.settings || {}),
          ...omitEmpty(fields),
        },
      };
    })
    : (Array.isArray(previous.backends) ? previous.backends : undefined);

  return {
    ...previous,
    mode: resolvedMode,
    engine: engine || previous.engine,
    baseUrl: baseUrl ?? previous.baseUrl,
    maxResults: Number.isFinite(Number(maxResults)) && Number(maxResults) > 0
      ? Number(maxResults)
      : (previous.maxResults || 8),
    fanout: {
      failurePolicy: 'partial',
      merge: 'round-robin',
      maxParallelBackends: Number.isFinite(Number(maxParallelBackends))
        ? Number(maxParallelBackends)
        : (previous.fanout?.maxParallelBackends ?? 0),
    },
    ...(backends ? { backends } : {}),
  };
}

function omitEmpty(object) {
  const result = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }
  return result;
}
