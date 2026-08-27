import { cosineSimilarity } from '../providers/openai-embedding-provider.mjs';
import { similarQuestions } from './exploratory-sufficiency.mjs';
import { registrableDomainFromUrl } from './source-policy.mjs';

function textOf(value) {
  if (typeof value === 'string') return value;
  return [value?.title, value?.snippet, value?.summary, value?.content, value?.question]
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function embedSafe(embedding, texts, { signal, purpose, traces } = {}) {
  if (!embedding?.embedDocuments) {
    traces?.push({
      provider: null,
      model: null,
      purpose,
      inputCount: texts.length,
      durationMs: 0,
      fallback: 'disabled',
    });
    return null;
  }
  const startedAt = Date.now();
  try {
    const vectors = await embedding.embedDocuments(texts, { signal, purpose });
    traces?.push({
      provider: embedding.provider || 'embedding',
      model: embedding.model || null,
      purpose,
      inputCount: texts.length,
      durationMs: Date.now() - startedAt,
      fallback: false,
    });
    return vectors;
  } catch {
    traces?.push({
      provider: embedding.provider || 'embedding',
      model: embedding.model || null,
      purpose,
      inputCount: texts.length,
      durationMs: Date.now() - startedAt,
      fallback: 'error',
    });
    return null;
  }
}

export async function queriesAreNearDuplicates(left, right, {
  embedding = null,
  signal,
  traces,
  threshold = 0.92,
} = {}) {
  if (!left || !right) return false;
  if (similarQuestions(left, right, 0.82)) return true;
  const vectors = await embedSafe(embedding, [left, right], {
    signal,
    purpose: 'query_dedup',
    traces,
  });
  if (!vectors || vectors.length < 2) return similarQuestions(left, right, 0.7);
  return cosineSimilarity(vectors[0], vectors[1]) >= threshold;
}

export async function clusterUrlRecords(records = [], {
  embedding = null,
  signal,
  traces,
  threshold = 0.9,
} = {}) {
  if (records.length < 2) {
    return records.map((record, offset) => ({
      ...record,
      clusterId: record.clusterId || `cluster-${offset + 1}`,
    }));
  }
  const texts = records.map((record) => textOf(record) || record.url || record.id);
  const vectors = await embedSafe(embedding, texts, {
    signal,
    purpose: 'url_cluster',
    traces,
  });
  const clustered = records.map((record) => ({ ...record, clusterId: record.clusterId || null }));
  if (!vectors) {
    return clustered.map((record, index) => {
      if (record.clusterId) return record;
      const reprint = clustered.find((other, otherIndex) => (
        otherIndex < index
        && other.registrableDomain
        && other.registrableDomain === (record.registrableDomain || registrableDomainFromUrl(record.url))
        && similarQuestions(other.title || '', record.title || '', 0.8)
      ));
      return { ...record, clusterId: reprint?.clusterId || `cluster-${index + 1}` };
    });
  }
  let nextId = 1;
  for (let index = 0; index < clustered.length; index += 1) {
    if (clustered[index].clusterId) continue;
    clustered[index].clusterId = `cluster-${nextId}`;
    nextId += 1;
    for (let other = index + 1; other < clustered.length; other += 1) {
      if (clustered[other].clusterId) continue;
      if (cosineSimilarity(vectors[index], vectors[other]) >= threshold) {
        clustered[other].clusterId = clustered[index].clusterId;
      }
    }
  }
  return clustered;
}

export async function readAddsNovelty({
  embedding = null,
  newText,
  knownTexts = [],
  signal,
  traces,
  threshold = 0.93,
} = {}) {
  const incoming = String(newText || '').trim();
  if (!incoming) return { novel: false, fallback: 'empty' };
  if (!knownTexts.length) return { novel: true, fallback: false };
  const vectors = await embedSafe(embedding, [incoming, ...knownTexts.map((item) => String(item || ''))], {
    signal,
    purpose: 'read_novelty',
    traces,
  });
  if (!vectors) {
    const overlap = knownTexts.some((item) => similarQuestions(incoming, item, 0.85));
    return { novel: !overlap, fallback: 'overlap' };
  }
  const [incomingVector, ...known] = vectors;
  const max = known.reduce((best, vector) => Math.max(best, cosineSimilarity(incomingVector, vector)), 0);
  return { novel: max < threshold, score: max, fallback: false };
}
