export const DEFAULT_SEARCH_CAPABILITIES = Object.freeze({
  maxQuestionConcurrency: null,
});

export function resolveSearchConcurrency(search, settings, fallback) {
  const configured = positiveInteger(settings.research?.concurrency, fallback);
  const providerLimit = search?.capabilities?.maxQuestionConcurrency;

  if (providerLimit == null) {
    return configured;
  }

  return Math.min(configured, positiveInteger(providerLimit, configured));
}

export function resolveCompositeQuestionConcurrency(engines = []) {
  let min = null;
  for (const engine of engines) {
    const limit = engine?.capabilities?.maxQuestionConcurrency;
    if (limit == null) continue;
    const number = Number(limit);
    if (!Number.isFinite(number) || number < 1) continue;
    const value = Math.floor(number);
    min = min == null ? value : Math.min(min, value);
  }
  return min;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}
