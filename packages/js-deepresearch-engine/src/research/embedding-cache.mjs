import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cosineSimilarity } from './providers/openai-embedding-provider.mjs';
import { PASSAGE_CHUNKING_VERSION } from './passage-utils.mjs';

const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const valid = (vector, dimensions) => Array.isArray(vector) && vector.length > 0
  && (!dimensions || vector.length === dimensions) && vector.every(Number.isFinite);

export function cacheEmbedding(embedding, { sessionDir, concurrency = 2, cooldownMs = 30000 } = {}) {
  if (!embedding?.embedDocuments) return embedding;
  const values = new Map();
  const pending = new Map();
  const namespace = hash(JSON.stringify([embedding.provider, embedding.baseUrl, embedding.model, embedding.dimensions || 'auto', PASSAGE_CHUNKING_VERSION]));
  const cacheDir = sessionDir ? path.join(sessionDir, 'embedding-cache', namespace) : null;
  const stats = { hits: 0, misses: 0, shared: 0, requests: 0, inputs: 0, diskHits: 0, degraded: 0 };
  const waiters = [];
  let active = 0;
  let dimensions = Number(embedding.dimensions) || 0;
  let failures = 0;
  let nextEligibleAt = 0;
  async function acquire() {
    if (active >= Math.max(1, concurrency)) await new Promise((resolve) => waiters.push(resolve));
    else active += 1;
  }
  function release() { const next = waiters.shift(); if (next) next(); else active -= 1; }
  function load(key) {
    if (!cacheDir) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8'));
      if (saved.key !== key || saved.vectorHash !== hash(JSON.stringify(saved.vector)) || !valid(saved.vector, dimensions)) return null;
      dimensions ||= saved.vector.length;
      stats.diskHits += 1;
      return Object.freeze(saved.vector);
    } catch { return null; } // Cache is disposable, never evidence authority.
  }
  function save(key, vector) {
    if (!cacheDir) return;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const file = path.join(cacheDir, `${key}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ key, vector, vectorHash: hash(JSON.stringify(vector)) }));
      fs.renameSync(temp, file);
    } catch { /* optional cache persistence */ }
  }
  const wrapper = {
    provider: embedding.provider, model: embedding.model, baseUrl: embedding.baseUrl, stats,
    async embedDocuments(texts, options = {}) {
      options.signal?.throwIfAborted?.();
      const role = options.purpose === 'evidence_question' ? 'question' : 'document';
      const entries = texts.map((text) => ({ text: String(text || '').trim(), key: hash(JSON.stringify([namespace, role, String(text || '').trim()])) }));
      const missing = [];
      const results = entries.map(({ key, text }) => {
        let vector = values.get(key);
        if (!vector) { vector = load(key); if (vector) values.set(key, vector); }
        if (vector) { stats.hits += 1; return Promise.resolve(vector); }
        if (pending.has(key)) { stats.shared += 1; return pending.get(key); }
        stats.misses += 1;
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        pending.set(key, promise);
        missing.push({ key, text, resolve, reject });
        return promise;
      });
      const batches = [];
      for (let offset = 0; offset < missing.length; offset += 64) batches.push(missing.slice(offset, offset + 64));
      const jobs = batches.map(async (batch) => {
        await acquire();
        try {
          options.signal?.throwIfAborted?.();
          if (Date.now() < nextEligibleAt) throw Object.assign(new Error('Embedding provider is cooling down.'), { code: 'EMBEDDING_COOLDOWN' });
          stats.requests += 1; stats.inputs += batch.length;
          const vectors = await embedding.embedDocuments(batch.map((entry) => entry.text), options);
          if (vectors.length !== batch.length || vectors.some((vector) => !valid(vector, dimensions || vectors[0]?.length))) throw new Error('Invalid embedding dimensions.');
          dimensions ||= vectors[0]?.length || 0;
          failures = 0;
          batch.forEach((entry, index) => {
            const vector = Object.freeze([...vectors[index]]);
            values.set(entry.key, vector); save(entry.key, vector); entry.resolve(vector);
          });
        } catch (error) {
          if (error?.name !== 'AbortError' && error?.name !== 'BudgetExceededError') {
            stats.degraded += 1;
            if (++failures >= 2) nextEligibleAt = Date.now() + cooldownMs;
          }
          for (const entry of batch) entry.reject(error);
        } finally {
          for (const entry of batch) pending.delete(entry.key);
          release();
        }
      });
      // Attach rejection handlers immediately; every queued batch is settled before returning.
      const settled = Promise.all(results);
      const [outcome] = await Promise.allSettled([settled, ...jobs]);
      if (outcome.status === 'rejected') throw outcome.reason;
      options.signal?.throwIfAborted?.();
      return outcome.value;
    },
  };
  wrapper.embed = async (text, options) => (await wrapper.embedDocuments([text], options))[0];
  wrapper.similarity = async (left, right, options) => {
    const [a, b] = await wrapper.embedDocuments([left, right], options);
    return cosineSimilarity(a, b);
  };
  return wrapper;
}
