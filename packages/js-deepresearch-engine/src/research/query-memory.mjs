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

function cosineSimilarity(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

export class QueryMemory {
  constructor({ enabled = false, semanticDedup = false, similarityThreshold = 0.86, similarityProvider = null, onSkip = () => {} } = {}) {
    this.enabled = enabled;
    this.similarityThreshold = Number(similarityThreshold) || 0.86;
    this.similarityProvider = semanticDedup ? similarityProvider : null;
    this.onSkip = onSkip;
    this.entries = [];
    this.vectorCache = new Map();
  }

  resultFingerprint(results = []) {
    return [...new Set((results || []).map((item) => item?.url).filter(Boolean))].sort().join('\n');
  }

  async queriesMatch(left, right) {
    const normalizedLeft = normalizeQuery(left);
    const normalizedRight = normalizeQuery(right);
    let score = normalizedLeft === normalizedRight ? 1 : querySimilarity(normalizedLeft, normalizedRight);
    if (score < this.similarityThreshold && this.similarityProvider?.similarity) {
      try { score = await this.similarityProvider.similarity(left, right); } catch { /* deterministic fallback */ }
    }
    return { match: score >= this.similarityThreshold, score };
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
      const { match, score } = await this.queriesMatch(normalized, entry.normalized);
      if (match) {
        this.onSkip({ query, duplicateOf: entry.query, score });
        return { entry, score };
      }
    }
    return null;
  }

  async filterDuplicates(queries = [], {
    gapId = null,
    embedding = null,
    signal,
    traces,
    semanticThreshold = 0.92,
  } = {}) {
    const candidates = [...new Set((queries || []).map(normalizeQuery).filter(Boolean))];
    if (!this.enabled) return { accepted: candidates, rejected: [], cacheHits: 0, embedded: 0 };
    const rejected = [];
    const accepted = [];
    const globalExact = new Map(
      this.entries.filter((entry) => entry.status !== 'cancelled').map((entry) => [entry.normalized, entry]),
    );
    const scopedEntries = this.entries.filter((entry) => entry.status !== 'cancelled' && entry.gapId === gapId);
    for (const candidate of candidates) {
      const exact = globalExact.get(candidate);
      if (exact) {
        rejected.push({ query: candidate, reason: 'exact_global', duplicateOf: exact.query, score: 1 });
        continue;
      }
      const lexical = [...scopedEntries, ...accepted.map((query) => ({ query, normalized: query }))]
        .find((entry) => querySimilarity(candidate, entry.normalized) >= this.similarityThreshold);
      if (lexical) {
        rejected.push({ query: candidate, reason: 'lexical_scope', duplicateOf: lexical.query, score: querySimilarity(candidate, lexical.normalized) });
        continue;
      }
      accepted.push(candidate);
    }

    if (!embedding?.embedDocuments || !accepted.length) {
      for (const item of rejected) this.onSkip(item);
      return { accepted, rejected, cacheHits: 0, embedded: 0 };
    }

    const scopedQueries = scopedEntries.map((entry) => entry.normalized);
    const needed = [...new Set([...accepted, ...scopedQueries])]
      .filter((query) => !this.vectorCache.has(query));
    const cacheHits = accepted.length + scopedQueries.length - needed.length;
    if (needed.length) {
      const startedAt = Date.now();
      try {
        const vectors = await embedding.embedDocuments(needed, { signal, purpose: 'query_dedup_batch' });
        needed.forEach((query, index) => {
          if (vectors?.[index]) this.vectorCache.set(query, vectors[index]);
        });
        traces?.push({
          provider: embedding.provider || 'embedding',
          model: embedding.model || null,
          purpose: 'query_dedup_batch',
          inputCount: needed.length,
          cacheHits,
          durationMs: Date.now() - startedAt,
          fallback: false,
        });
      } catch {
        traces?.push({
          provider: embedding.provider || 'embedding',
          model: embedding.model || null,
          purpose: 'query_dedup_batch',
          inputCount: needed.length,
          cacheHits,
          durationMs: Date.now() - startedAt,
          fallback: 'error',
        });
      }
    }

    const semanticAccepted = [];
    for (const candidate of accepted) {
      const vector = this.vectorCache.get(candidate);
      const pool = [...scopedQueries, ...semanticAccepted];
      const duplicateOf = vector && pool.find((query) => (
        cosineSimilarity(vector, this.vectorCache.get(query)) >= semanticThreshold
      ));
      if (duplicateOf) {
        rejected.push({ query: candidate, reason: 'semantic_scope', duplicateOf, score: semanticThreshold });
      } else {
        semanticAccepted.push(candidate);
      }
    }
    for (const item of rejected) this.onSkip(item);
    return { accepted: semanticAccepted, rejected, cacheHits, embedded: needed.length };
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
