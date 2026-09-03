export const SEARCH_OPTION_KEYS = Object.freeze([
  'engines',
  'categories',
  'language',
  'pageno',
  'safesearch',
]);

export const DEFAULT_SEARCH_CAPABILITIES = Object.freeze({
  maxQuestionConcurrency: null,
  supportedSearchOptions: SEARCH_OPTION_KEYS,
  fixedEngine: null,
});

export function resolveSearchCapabilities(search = {}) {
  return {
    ...DEFAULT_SEARCH_CAPABILITIES,
    ...(search?.capabilities || {}),
  };
}

export function filterSearchOptions(requested, capabilities = {}) {
  const requestedOptions = requested && typeof requested === 'object' && !Array.isArray(requested)
    ? { ...requested }
    : {};
  const supportedList = Array.isArray(capabilities.supportedSearchOptions)
    ? capabilities.supportedSearchOptions
    : SEARCH_OPTION_KEYS;
  const supported = new Set(supportedList);
  const effective = {};
  const dropped = [];
  for (const [key, value] of Object.entries(requestedOptions)) {
    if (supported.has(key)) effective[key] = value;
    else dropped.push(key);
  }
  return {
    requested: requestedOptions,
    effective,
    dropped,
  };
}

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
