function terms(value) {
  return new Set(normalizeQuery(value).split(' ').filter((term) => term.length > 1));
}

export function normalizeQuery(value = '') {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/\bsite\s*:\s*/g, 'site:')
    .replace(/[^\p{L}\p{N}:./_-]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function querySimilarity(left, right) {
  const a = terms(left);
  const b = terms(right);
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter((term) => b.has(term)).length;
  return overlap / (a.size + b.size - overlap);
}

export class QueryMemory {
  constructor({ enabled = false, semanticDedup = false, similarityThreshold = 0.86, similarityProvider = null, onSkip = () => {} } = {}) {
    this.enabled = enabled;
    this.similarityThreshold = Number(similarityThreshold) || 0.86;
    this.similarityProvider = semanticDedup ? similarityProvider : null;
    this.onSkip = onSkip;
    this.entries = [];
  }

  resultFingerprint(results = []) {
    return [...new Set((results || []).map((item) => item?.url).filter(Boolean))].sort().join('\n');
  }

  async findDuplicate(query, gapId = null, options = {}) {
    if (!this.enabled) return null;
    const fingerprint = this.resultFingerprint(options.results);
    if (fingerprint) {
      const hit = this.entries.find((item) => item.status !== 'cancelled' && item.resultFingerprint === fingerprint);
      if (hit) {
        this.onSkip({ query, duplicateOf: hit.query, score: 1, reason: 'duplicate_results' });
        return { entry: hit, score: 1, reason: 'duplicate_results' };
      }
    }
    const normalized = normalizeQuery(query);
    for (const entry of this.entries.filter((item) => item.status !== 'cancelled' && item.gapId === gapId)) {
      let score = normalized === entry.normalized ? 1 : querySimilarity(normalized, entry.normalized);
      if (score < this.similarityThreshold && this.similarityProvider?.similarity) {
        try { score = await this.similarityProvider.similarity(query, entry.query); } catch { /* deterministic fallback */ }
      }
      if (score >= this.similarityThreshold) {
        this.onSkip({ query, duplicateOf: entry.query, score });
        return { entry, score };
      }
    }
    return null;
  }

  record({ query, gapId = null, provider = '', status, results = [] }) {
    const fingerprint = this.resultFingerprint(results);
    const duplicateResults = fingerprint && this.entries.some((item) => item.resultFingerprint === fingerprint);
    const entry = { query, normalized: normalizeQuery(query), gapId, provider, status: duplicateResults ? 'duplicate_results' : status, resultCount: results.length, resultFingerprint: fingerprint, createdAt: new Date().toISOString() };
    if (status !== 'cancelled') this.entries.push(entry);
    return entry;
  }

  snapshot() { return this.entries.map((entry) => ({ ...entry })); }
}
