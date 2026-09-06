import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostnameOf, hostnamesMatch } from './adaptive/source-policy.mjs';

export const DEFAULT_CONTENT_CACHE_DIR = 'data/content-cache';
const DEFAULT_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 30 * 60 * 1000;

export function normalizeCacheUrl(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    parsed.hostname = String(parsed.hostname || '').toLowerCase();
    if (
      (parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }
    return parsed.href;
  } catch {
    return String(url || '').trim();
  }
}

export function contentSha256(text = '') {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function resolveContentCacheSettings(settings = {}) {
  const raw = settings?.research?.read?.cache || {};
  const ttlMs = raw.ttlMs && typeof raw.ttlMs === 'object' ? raw.ttlMs : {};
  return {
    enabled: raw.enabled === true || (raw.enabled !== false && Object.keys(raw).length > 0),
    dir: String(raw.dir || DEFAULT_CONTENT_CACHE_DIR),
    ttlMs: {
      html: Number(ttlMs.html) > 0 ? Number(ttlMs.html) : DEFAULT_POSITIVE_TTL_MS,
      default: Number(ttlMs.default) > 0 ? Number(ttlMs.default) : DEFAULT_POSITIVE_TTL_MS,
    },
    negativeTtlMs: Number(raw.negativeTtlMs) > 0 ? Number(raw.negativeTtlMs) : DEFAULT_NEGATIVE_TTL_MS,
    forceRefreshRequiredHosts: raw.forceRefreshRequiredHosts !== false,
  };
}

export function buildCacheKey(url, extras = {}) {
  const backends = Array.isArray(extras.backends)
    ? extras.backends.join(',')
    : String(extras.backend || extras.backends || 'auto');
  const payload = [
    normalizeCacheUrl(url),
    backends,
    extras.fetchMode || extras.format || '',
    extras.maxChars || '',
  ].join('|');
  return contentSha256(payload);
}

export function cacheFilePath(dir, key) {
  return path.join(String(dir || DEFAULT_CONTENT_CACHE_DIR), `${key}.json`);
}

function isNegativeResult(result = {}) {
  if (result.status === 'failed' || result.status === 'skipped') return true;
  if (result.negative === true) return true;
  if (Number(result.httpStatus) === 403 || Number(result.httpStatus) === 429) return true;
  if (result.errorType === 'challenge' || result.challenge === true) return true;
  return false;
}

function ttlFor(entry, cache) {
  if (entry?.negative || isNegativeResult(entry)) return cache.negativeTtlMs;
  const via = String(entry?.retrievedVia || entry?.backend || '');
  if (via.includes('html') || via === 'direct' || via === 'http') return cache.ttlMs.html;
  return cache.ttlMs.default;
}

function matchesRequiredHost(url, requiredHosts = []) {
  const host = hostnameOf(url);
  return Boolean(host) && (requiredHosts || []).some((item) => hostnamesMatch(host, item));
}

export function lookupContentCache(url, settings = {}, extras = {}) {
  const cache = extras.cache || resolveContentCacheSettings(settings);
  if (!cache.enabled) return null;
  const fsImpl = extras.fs || fs;
  const key = extras.key || buildCacheKey(url, extras);
  const filePath = cacheFilePath(cache.dir, key);
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  const fetchedAt = Date.parse(entry?.fetchedAt || '');
  if (!Number.isFinite(fetchedAt)) return null;
  if (Date.now() - fetchedAt > ttlFor(entry, cache)) return null;
  const negative = entry.negative === true || isNegativeResult(entry);
  if (!negative && cache.forceRefreshRequiredHosts && matchesRequiredHost(url, extras.requiredHosts)) {
    return null;
  }
  return {
    ...entry,
    cacheHit: true,
    cacheSource: 'disk',
    cacheKey: key,
  };
}

export function storeContentCache(url, result = {}, settings = {}, extras = {}) {
  const cache = extras.cache || resolveContentCacheSettings(settings);
  if (!cache.enabled) return null;
  if (result?.errorType === 'aborted' || result?.status === 'unsupported') return null;
  const fsImpl = extras.fs || fs;
  const key = extras.key || buildCacheKey(url, extras);
  const negative = isNegativeResult(result);
  const content = String(result.content || result.summary || '');
  const entry = {
    url: normalizeCacheUrl(url),
    fetchedAt: result.retrievedAt || result.fetchedAt || new Date().toISOString(),
    fetchStatus: result.status === 'ok' && !negative ? 'ok' : (result.status || 'failed'),
    retrievedVia: result.retrievedVia || result.retrievalPath || 'direct',
    finalUrl: result.finalUrl || url,
    contentSha256: result.contentSha256 || (content ? contentSha256(content) : null),
    title: result.title || null,
    content: result.content || null,
    summary: result.summary || null,
    backend: result.backend || null,
    retrievalPath: result.retrievalPath || null,
    httpStatus: result.httpStatus ?? null,
    error: result.error || null,
    errorType: result.errorType || null,
    evidenceRole: result.evidenceRole || null,
    snapshotUrl: result.snapshotUrl || null,
    snapshotTime: result.snapshotTime || null,
    publishedAt: result.publishedAt || null,
    sourceUrl: result.sourceUrl || null,
    manualImportPath: result.manualImportPath || null,
    accessStatus: result.accessStatus || null,
    evidenceTier: result.evidenceTier || null,
    negative,
  };
  const filePath = cacheFilePath(cache.dir, key);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return { key, filePath, entry };
}
