import { cosineSimilarity } from '../providers/openai-embedding-provider.mjs';
import { normalizeQuery, querySimilarity } from '../query-memory.mjs';
import { clusterCandidatesByOverlap } from './url-pool.mjs';

function pushTrace(traces, entry) {
  traces?.push({
    createdAt: new Date().toISOString(),
    ...entry,
  });
}

export async function embedWithTrace(embedding, texts, {
  purpose = 'unspecified',
  traces = null,
  signal,
} = {}) {
  const inputs = (texts || []).map((text) => String(text || '').trim()).filter(Boolean);
  const startedAt = Date.now();
  const provider = embedding?.provider || embedding?.constructor?.name || null;
  const model = embedding?.model || null;
  if (!embedding?.embedDocuments || !inputs.length) {
    pushTrace(traces, {
      provider,
      model,
      purpose,
      inputCount: inputs.length,
      durationMs: 0,
      fallback: true,
      status: embedding ? 'skipped' : 'disabled',
    });
    return { vectors: null, fallback: true };
  }
  try {
    const vectors = await embedding.embedDocuments(inputs, { signal, purpose });
    pushTrace(traces, {
      provider,
      model,
      purpose,
      inputCount: inputs.length,
      durationMs: Date.now() - startedAt,
      fallback: false,
      status: 'completed',
    });
    return { vectors, fallback: false };
  } catch {
    pushTrace(traces, {
      provider,
      model,
      purpose,
      inputCount: inputs.length,
      durationMs: Date.now() - startedAt,
      fallback: true,
      status: 'failed',
    });
    return { vectors: null, fallback: true };
  }
}

export async function queriesAreNearDuplicates(left, right, {
  embedding = null,
  traces = null,
  signal,
  lexicalThreshold = 0.72,
  semanticThreshold = 0.9,
} = {}) {
  if (normalizeQuery(left) === normalizeQuery(right) && normalizeQuery(left)) return { duplicate: true, score: 1, method: 'exact' };
  const lexical = querySimilarity(left, right);
  if (lexical >= lexicalThreshold) return { duplicate: true, score: lexical, method: 'overlap' };
  if (!embedding?.embedDocuments) return { duplicate: false, score: lexical, method: 'overlap' };
  const { vectors, fallback } = await embedWithTrace(embedding, [left, right], {
    purpose: 'query_semantic_dedup',
    traces,
    signal,
  });
  if (fallback || !vectors?.[0] || !vectors?.[1]) {
    return { duplicate: false, score: lexical, method: 'overlap' };
  }
  const score = cosineSimilarity(vectors[0], vectors[1]);
  return { duplicate: score >= semanticThreshold, score, method: 'embedding' };
}

export async function clusterUrlPool(candidates, {
  embedding = null,
  traces = null,
  signal,
  threshold = 0.9,
} = {}) {
  const items = clusterCandidatesByOverlap(candidates);
  if (!embedding?.embedDocuments) return { clustered: items.length, fallback: true };
  const unread = items.filter((item) => item.status === 'unread' || item.status === 'duplicate');
  if (unread.length < 2) return { clustered: items.length, fallback: false };
  const texts = unread.map((item) => [item.title, item.snippet].filter(Boolean).join('\n'));
  const { vectors, fallback } = await embedWithTrace(embedding, texts, {
    purpose: 'url_snippet_clustering',
    traces,
    signal,
  });
  if (fallback || !vectors) return { clustered: items.length, fallback: true };
  for (let i = 0; i < unread.length; i += 1) {
    for (let j = i + 1; j < unread.length; j += 1) {
      if (!vectors[i] || !vectors[j]) continue;
      const score = cosineSimilarity(vectors[i], vectors[j]);
      if (score < threshold) continue;
      unread[j].clusterId = unread[i].clusterId || unread[j].clusterId || `embed-${i}`;
      unread[i].clusterId = unread[j].clusterId;
      if (unread[j].status === 'unread' && unread[i].registrableDomain === unread[j].registrableDomain) {
        unread[j].status = 'duplicate';
        unread[j].skipReason = unread[j].skipReason || 'embedding_reprint';
      }
    }
  }
  return { clustered: items.length, fallback: false };
}

export async function readAddedNewInfo({
  embedding,
  traces,
  signal,
  previousTexts = [],
  nextText = '',
  threshold = 0.92,
} = {}) {
  const incoming = String(nextText || '').trim();
  if (!incoming) return { novel: false, fallback: true, score: 0 };
  if (!previousTexts.length) return { novel: true, fallback: true, score: 0 };
  if (!embedding?.embedDocuments) {
    const overlap = Math.max(...previousTexts.map((text) => querySimilarity(incoming, text)));
    return { novel: overlap < 0.72, fallback: true, score: overlap, method: 'overlap' };
  }
  const { vectors, fallback } = await embedWithTrace(embedding, [...previousTexts.slice(-4), incoming], {
    purpose: 'read_novelty',
    traces,
    signal,
  });
  if (fallback || !vectors?.length) {
    const overlap = Math.max(...previousTexts.map((text) => querySimilarity(incoming, text)));
    return { novel: overlap < 0.72, fallback: true, score: overlap, method: 'overlap' };
  }
  const nextVector = vectors[vectors.length - 1];
  let best = 0;
  for (const vector of vectors.slice(0, -1)) {
    best = Math.max(best, cosineSimilarity(vector, nextVector));
  }
  return { novel: best < threshold, fallback: false, score: best, method: 'embedding' };
}
