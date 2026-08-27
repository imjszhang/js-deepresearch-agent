import { hostnameOf, registrableDomain } from './hostname-policy.mjs';
import { decorateCandidate } from './source-policy.mjs';
import { normalizeSourceUrl } from '../source-candidates.mjs';

export const URL_STATUSES = Object.freeze(['unread', 'read', 'failed', 'waf', 'duplicate']);

function candidateKey(source) {
  return String(source?.id || source?.url || '').trim();
}

function findExisting(candidates, id, normalized) {
  if (candidates.has(id)) return candidates.get(id);
  if (!normalized) return null;
  for (const candidate of candidates.values()) {
    if (candidate.normalizedUrl === normalized || candidate.id === normalized || candidate.url === normalized) {
      return candidate;
    }
  }
  return null;
}

export function upsertUrlPool(candidates, sources = [], {
  gapId = 'gap-1',
  query = '',
  gap = {},
} = {}) {
  let added = 0;
  let duplicates = 0;
  for (const source of sources || []) {
    const id = candidateKey(source);
    if (!id) continue;
    const normalized = normalizeSourceUrl(source.url || id) || id;
    const existing = findExisting(candidates, id, normalized);
    if (existing) {
      duplicates += 1;
      existing.freq = (existing.freq || 0) + 1;
      if (query && !(existing.queries || []).includes(query)) {
        existing.queries = [...(existing.queries || []), query];
      }
      if (gapId && existing.gapId !== gapId && !existing.gapIds?.includes(gapId)) {
        existing.gapIds = [...(existing.gapIds || [existing.gapId].filter(Boolean)), gapId];
      }
      continue;
    }
    const decorated = decorateCandidate({
      ...source,
      id,
      url: source.url || id,
      normalizedUrl: normalized,
      gapId,
      gapIds: [gapId],
      query,
      queries: query ? [query] : [],
      freq: 1,
      status: 'unread',
      clusterId: null,
      skipReason: null,
      selectReason: null,
    }, gap);
    decorated.normalizedUrl = normalized;
    decorated.hostname = decorated.hostname || hostnameOf(decorated.url);
    decorated.registrableDomain = decorated.registrableDomain || registrableDomain(decorated.hostname);
    candidates.set(id, decorated);
    added += 1;
  }
  return { added, duplicates, total: candidates.size };
}

export function markCandidateStatus(candidates, sourceId, status, reason = null) {
  const candidate = candidates.get(sourceId);
  if (!candidate) return null;
  candidate.status = status;
  if (reason) candidate.skipReason = reason;
  return candidate;
}

export function unreadForGap(candidates, gapId, { includeUnassigned = true } = {}) {
  return [...candidates.values()].filter((candidate) => {
    if (candidate.status && candidate.status !== 'unread') return false;
    if (!gapId) return true;
    if (candidate.gapId === gapId || (candidate.gapIds || []).includes(gapId)) return true;
    return includeUnassigned && !candidate.gapId;
  });
}

export function clusterCandidatesByOverlap(candidates, { threshold = 0.72 } = {}) {
  const items = [...candidates.values()];
  let clusterSerial = 1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].clusterId) continue;
    const clusterId = `cluster-${clusterSerial}`;
    clusterSerial += 1;
    items[i].clusterId = clusterId;
    const left = new Set(String(`${items[i].title || ''} ${items[i].snippet || ''}`).toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j].clusterId) continue;
      if (items[i].registrableDomain && items[i].registrableDomain === items[j].registrableDomain) {
        items[j].clusterId = clusterId;
        items[j].status = items[j].status === 'unread' ? 'duplicate' : items[j].status;
        items[j].skipReason = items[j].skipReason || 'same_domain_reprint';
        continue;
      }
      const rightTokens = String(`${items[j].title || ''} ${items[j].snippet || ''}`).toLowerCase().split(/\W+/).filter((token) => token.length > 2);
      if (!left.size || !rightTokens.length) continue;
      const overlap = rightTokens.filter((token) => left.has(token)).length;
      const union = new Set([...left, ...rightTokens]).size;
      // Similar titles from different publishers are a cluster for diversity,
      // not a reprint. Only same-domain copies may leave the unread pool.
      if (union && overlap / union >= threshold && Math.min(left.size, rightTokens.length) >= 4) {
        items[j].clusterId = clusterId;
      }
    }
  }
  return items;
}
