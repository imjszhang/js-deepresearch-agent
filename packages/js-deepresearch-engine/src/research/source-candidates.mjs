const TRACKING_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']);

export function normalizeSourceUrl(value = '') {
  try {
    const url = new URL(String(value).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

function hostname(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const PRIMARY_HOSTS = /(?:^|\.)(?:github\.com|gitlab\.com|codeberg\.org|arxiv\.org|doi\.org)$/;
const SECONDARY_HOSTS = /(?:^|\.)(?:csdn\.net|zhihu\.com|163\.com|qq\.com|cnblogs\.com)$/;

export function isPrimarySource(source = {}) {
  const host = hostname(source.url);
  const title = titleKey(source.title);
  if (PRIMARY_HOSTS.test(host)) return true;
  if (/^(?:docs|developer|support)\./.test(host) && !SECONDARY_HOSTS.test(host)
    && /\b(?:official|documentation|docs|api|reference|specification)\b|官方|文档|规范|接口参考/.test(title)) return true;
  return !SECONDARY_HOSTS.test(host)
    && /\b(?:official|documentation|repository|specification|paper)\b|官方(?:文档|仓库|网站)|源代码|论文/.test(title);
}

function sourceAuthorityScore(source) {
  const host = hostname(source.url);
  if (isPrimarySource(source)) return 0.8;
  if (SECONDARY_HOSTS.test(host)) return -0.15;
  if (/(?:^|\.)(?:gov|edu)\.[a-z]+$/.test(host)) return 0.35;
  return 0;
}

function titleKey(value = '') {
  return String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function lexicalScore(query, source) {
  const wanted = new Set(titleKey(query).split(' ').filter((term) => term.length > 1));
  const available = new Set(titleKey(`${source.title || ''} ${source.snippet || ''}`).split(' '));
  if (!wanted.size) return 0;
  return [...wanted].filter((term) => available.has(term)).length / wanted.size;
}

function freshnessScore(source) {
  const timestamp = Date.parse(source.publishedAt || source.date || source.updatedAt || '');
  if (!Number.isFinite(timestamp)) return 0;
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 1 - days / 730);
}

export function selectDiverseSources(sources = [], { enabled = false, maxPerHostname = 2, clusterResults = false } = {}) {
  if (!enabled) return sources;
  const seenUrls = new Set();
  const seenClusters = new Set();
  const hostCounts = new Map();
  const selected = [];

  for (const raw of sources) {
    const url = normalizeSourceUrl(raw?.url);
    const key = url || `${titleKey(raw?.title)}:${titleKey(raw?.snippet)}`;
    if (!key || seenUrls.has(key)) continue;
    const host = hostname(url);
    if (host && (hostCounts.get(host) || 0) >= maxPerHostname) continue;
    const cluster = `${host}:${titleKey(raw?.title).split(' ').slice(0, 8).join(' ')}`;
    if (clusterResults && cluster !== ':' && seenClusters.has(cluster)) continue;
    seenUrls.add(key);
    seenClusters.add(cluster);
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    selected.push({ ...raw, url });
  }
  return selected;
}

export function applySourceSelection(findings, options) {
  if (!options?.enabled) return findings;
  return findings.map((finding) => {
    const pool = new SourceCandidatePool();
    for (const source of finding.sources || []) pool.add(source, { gapId: finding.gapId, query: finding.question });
    return { ...finding, sources: pool.select(options) };
  });
}

export class SourceCandidatePool {
  constructor() {
    this.candidates = new Map();
    this.hostFailures = new Map();
  }

  add(source, { gapId = null, query = '', weight = 1 } = {}) {
    const url = normalizeSourceUrl(source?.url);
    const key = url || `${titleKey(source?.title)}:${titleKey(source?.snippet)}`;
    if (!key) return null;
    const existing = this.candidates.get(key) || { ...source, url, gapIds: [], queries: [], hits: 0, weight: 0, status: 'candidate' };
    if (gapId && !existing.gapIds.includes(gapId)) existing.gapIds.push(gapId);
    if (query && !existing.queries.includes(query)) existing.queries.push(query);
    existing.hits += 1;
    existing.weight += weight;
    existing.title ||= source?.title || '';
    existing.snippet ||= source?.snippet || '';
    if (!existing.summary || String(source?.summary || '').length > String(existing.summary || '').length) existing.summary = source?.summary || existing.summary;
    if (!existing.content || String(source?.content || '').length > String(existing.content || '').length) existing.content = source?.content || existing.content;
    if (source?.fetchStatus === 'ok' || !existing.fetchStatus) existing.fetchStatus = source?.fetchStatus || existing.fetchStatus;
    if (source?.contentOrigin) existing.contentOrigin = source.contentOrigin;
    if (source?.fetchError && !existing.fetchError) existing.fetchError = source.fetchError;
    this.candidates.set(key, existing);
    return existing;
  }

  mark(url, status) {
    const key = normalizeSourceUrl(url);
    const entry = this.candidates.get(key);
    if (entry) entry.status = status;
    if (status === 'failed') {
      const host = hostname(key);
      if (host) this.hostFailures.set(host, (this.hostFailures.get(host) || 0) + 1);
    }
  }

  select(options = {}) {
    const blocked = new Set(options.badHostnames || []);
    const boosted = new Set(options.boostHostnames || []);
    const ranked = [...this.candidates.values()].filter((item) => !blocked.has(hostname(item.url))).map((item) => {
      const host = hostname(item.url);
      const relevance = Math.max(0, ...item.queries.map((query) => lexicalScore(query, item)));
      const authority = sourceAuthorityScore(item);
      const score = relevance + freshnessScore(item) * 0.25 + Math.min(item.hits, 3) * 0.1 + authority + (boosted.has(host) ? 0.5 : 0);
      return { ...item, sourceKind: isPrimarySource(item) ? 'primary' : 'secondary', score };
    }).sort((a, b) => {
      const aPenalty = this.hostFailures.get(hostname(a.url)) || 0;
      const bPenalty = this.hostFailures.get(hostname(b.url)) || 0;
      return (b.score + b.weight * 0.05 - bPenalty) - (a.score + a.weight * 0.05 - aPenalty);
    });
    return selectDiverseSources(ranked, { enabled: true, ...options });
  }

  snapshot() { return [...this.candidates.values()].map((item) => ({ ...item })); }
}
