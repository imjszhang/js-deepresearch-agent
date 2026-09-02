import { normalizeSourceUrl, sourceDiversityKey } from '../source-candidates.mjs';
import {
  classifySourceTier,
  hostnameOf,
  registrableDomainFromUrl,
} from './source-policy.mjs';

export const URL_POOL_STATUSES = Object.freeze([
  'unread',
  'read',
  'failed',
  'waf',
  'irrelevant',
  'duplicate',
]);

export function normalizePoolUrl(url) {
  return normalizeSourceUrl(url) || String(url || '').trim();
}

export function buildUrlRecord(source = {}, {
  gapId = 'gap-1',
  query = '',
  gap = {},
  clusterId = null,
} = {}) {
  const url = source.url || source.id;
  const id = source.id || url;
  const gapKey = gapId || 'gap-1';
  return {
    id,
    url,
    normalizedUrl: normalizePoolUrl(url),
    hostname: hostnameOf(url),
    diversityKey: sourceDiversityKey(source, url),
    registrableDomain: registrableDomainFromUrl(url),
    gapId: gapKey,
    gapIds: [gapKey],
    gapMatches: {
      [gapKey]: {
        queries: query ? [query] : [],
        tier: source.tier || classifySourceTier(source, gap),
        rerank: source.rerank || null,
        rerankScore: source.rerank?.score ?? source.rerankScore ?? null,
      },
    },
    query,
    title: source.title || '',
    snippet: source.snippet || '',
    date: source.publishedAt || source.date || source.updatedAt || null,
    sourceType: source.sourceType || null,
    tier: source.tier || classifySourceTier(source, gap),
    rerankScore: source.rerank?.score ?? source.rerankScore ?? null,
    clusterId: clusterId || source.clusterId || null,
    status: source.status || 'unread',
    skipReason: source.skipReason || null,
    selectReason: source.selectReason || null,
    freq: source.freq || 1,
  };
}

export class UrlPool {
  constructor({ maxPerHostname = 2 } = {}) {
    this.records = new Map();
    this.maxPerHostname = Math.max(1, Number(maxPerHostname) || 2);
  }

  get(id) {
    return this.records.get(id) || null;
  }

  values() {
    return [...this.records.values()];
  }

  add(source, context = {}) {
    const record = buildUrlRecord(source, context);
    if (!record.id) return null;
    const existing = this.records.get(record.id);
    if (existing) {
      existing.freq = (existing.freq || 0) + 1;
      existing.title ||= record.title;
      existing.snippet ||= record.snippet;
      existing.gapId ||= record.gapId;
      existing.gapIds = [...new Set([...(existing.gapIds || [existing.gapId]), record.gapId].filter(Boolean))];
      const priorMatch = existing.gapMatches?.[record.gapId] || {};
      const nextMatch = record.gapMatches?.[record.gapId] || {};
      existing.gapMatches = {
        ...(existing.gapMatches || {}),
        [record.gapId]: {
          ...priorMatch,
          ...nextMatch,
          queries: [...new Set([...(priorMatch.queries || []), ...(nextMatch.queries || [])])],
        },
      };
      if (record.clusterId) existing.clusterId = record.clusterId;
      if (record.tier && existing.tier !== 'required_primary') existing.tier = record.tier;
      return { record: existing, added: false };
    }
    const duplicate = this.findDuplicate(record);
    if (duplicate) {
      record.status = 'duplicate';
      record.skipReason = 'same_domain_reprint';
      record.clusterId = duplicate.clusterId || duplicate.id;
    }
    this.records.set(record.id, { ...source, ...record });
    return { record: this.records.get(record.id), added: record.status === 'unread' };
  }

  findDuplicate(record) {
    if (!record.registrableDomain && !record.title) return null;
    const titleKey = String(record.title || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return this.values().find((item) => {
      if (item.id === record.id) return false;
      if (item.status === 'duplicate') return false;
      const sameDomain = record.registrableDomain && item.registrableDomain === record.registrableDomain;
      const itemTitle = String(item.title || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const similarTitle = titleKey && itemTitle && (titleKey === itemTitle || titleKey.includes(itemTitle) || itemTitle.includes(titleKey));
      return sameDomain && similarTitle;
    }) || null;
  }

  mark(id, status, reason = null) {
    const record = this.records.get(id);
    if (!record) return null;
    record.status = status;
    if (reason) record.skipReason = reason;
    return record;
  }

  unreadForGap(gapId, { includeUnassigned = true } = {}) {
    return this.values().filter((record) => {
      if (record.status !== 'unread') return false;
      if (record.gapId === gapId) return true;
      return includeUnassigned && !record.gapId;
    });
  }

  hostnameUnreadCounts() {
    const counts = new Map();
    for (const record of this.values()) {
      if (record.status !== 'unread' || !record.hostname) continue;
      counts.set(record.hostname, (counts.get(record.hostname) || 0) + 1);
    }
    return counts;
  }

  applyHostnameCap(records = this.unreadForGap()) {
    const counts = new Map();
    const kept = [];
    for (const record of records) {
      const host = record.diversityKey || record.hostname;
      const count = host ? (counts.get(host) || 0) : 0;
      if (host && count >= this.maxPerHostname) {
        if (record.status === 'unread') {
          record.skipReason = record.skipReason || 'hostname_cap';
        }
        continue;
      }
      if (host) counts.set(host, count + 1);
      kept.push(record);
    }
    return kept;
  }
}
