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

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}
