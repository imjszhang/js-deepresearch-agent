import { querySimilarity } from './query-memory.mjs';

export const deterministicResearchProviders = Object.freeze({
  similarity: { async similarity(left, right) { return querySimilarity(left, right); } },
  rerank: { async rerank(_query, items) { return items.map((item, index) => ({ item, score: 1 / (index + 1) })); } },
  embedding: null,
  evidenceJudge: null,
  contentReader: null,
  freshnessResolver: { async resolve(source) { return source?.publishedAt || source?.date || null; } },
});

export function createResearchProviders(overrides = {}) {
  return { ...deterministicResearchProviders, ...overrides };
}
