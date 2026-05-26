import { resolveSearchConcurrency } from '../search/search-capabilities.mjs';

export function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

export function uniqueQuestionCount(questions) {
  return new Set((questions || []).map((question) => String(question || '').trim()).filter(Boolean)).size;
}

export function resolveStrategyConcurrency(search, concurrency, fallback) {
  return resolveSearchConcurrency(search, { research: { concurrency } }, fallback);
}
