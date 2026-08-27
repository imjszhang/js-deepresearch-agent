import { hostnameOf, hostMatchesAny, registrableDomain, siteQueryForHost } from './hostname-policy.mjs';

export const SOURCE_TIERS = Object.freeze([
  'required_primary',
  'other_primary',
  'specialist',
  'mainstream',
  'reprint',
  'ugc',
]);

const TIER_RANK = Object.fromEntries(SOURCE_TIERS.map((tier, index) => [tier, index]));

const PRIMARY_HOST_PATTERNS = [
  /(^|\.)github\.com$/,
  /(^|\.)gitlab\.com$/,
  /(^|\.)codeberg\.org$/,
  /(^|\.)arxiv\.org$/,
  /(^|\.)doi\.org$/,
  /(^|\.)hkexnews\.hk$/,
  /(^|\.)sec\.gov$/,
  /(^|\.)sse\.com\.cn$/,
  /(^|\.)szse\.cn$/,
  /(^|\.)nasdaq\.com$/,
  /(^|\.)nyse\.com$/,
  /(^|\.)gov$/,
  /(^|\.)gov\.[a-z.]+$/,
  /(^|\.)edu$/,
  /(^|\.)edu\.[a-z.]+$/,
  /^docs\./,
  /^developer\./,
  /^developers\./,
  /^support\./,
  /^ir\./,
  /^investors\./,
];

const SPECIALIST_HOST_PATTERNS = [
  /(^|\.)wikipedia\.org$/,
  /(^|\.)readthedocs\.io$/,
  /(^|\.)ietf\.org$/,
  /(^|\.)w3\.org$/,
  /(^|\.)acm\.org$/,
  /(^|\.)ieee\.org$/,
  /(^|\.)nature\.com$/,
  /(^|\.)sciencedirect\.com$/,
];

const MAINSTREAM_HOST_PATTERNS = [
  /(^|\.)reuters\.com$/,
  /(^|\.)bloomberg\.com$/,
  /(^|\.)wsj\.com$/,
  /(^|\.)ft\.com$/,
  /(^|\.)nytimes\.com$/,
  /(^|\.)apnews\.com$/,
  /(^|\.)bbc\.(co\.uk|com)$/,
  /(^|\.)cnbc\.com$/,
  /(^|\.)forbes\.com$/,
  /(^|\.)techcrunch\.com$/,
  /(^|\.)theverge\.com$/,
  /(^|\.)36kr\.com$/,
  /(^|\.)caixin\.com$/,
  /(^|\.)yicai\.com$/,
  /(^|\.)stcn\.com$/,
  /(^|\.)cls\.cn$/,
];

const REPRINT_HOST_PATTERNS = [
  /(^|\.)news\.yahoo\.com$/,
  /(^|\.)msn\.com$/,
  /(^|\.)news\.google\.com$/,
  /(^|\.)toutiao\.com$/,
  /(^|\.)sohu\.com$/,
  /(^|\.)sina\.com\.cn$/,
  /(^|\.)163\.com$/,
  /(^|\.)qq\.com$/,
  /(^|\.)csdn\.net$/,
];

const UGC_HOST_PATTERNS = [
  /(^|\.)medium\.com$/,
  /(^|\.)zhihu\.com$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)xiaohongshu\.com$/,
  /(^|\.)substack\.com$/,
  /(^|\.)dev\.to$/,
  /(^|\.)hashnode\.dev$/,
  /(^|\.)cnblogs\.com$/,
  /(^|\.)juejin\.cn$/,
  /(^|\.)blogspot\.com$/,
  /(^|\.)wordpress\.com$/,
];

const PRIMARY_TITLE = /\b(?:official|documentation|docs|repository|specification|filing|prospectus|10-k|10-q|annual report|form 20-f)\b|官方(?:文档|仓库|网站|披露)|招股书|年报|监管披露|源代码|论文/;

function hostFrom(source) {
  return hostnameOf(source?.url || source?.id || '');
}

function titleText(source) {
  return `${source?.title || ''} ${source?.snippet || ''}`.toLowerCase();
}

function matchesAnyHost(hostname, patterns) {
  return patterns.some((pattern) => pattern.test(hostname));
}

export function classifySourceTier(source = {}, gap = {}) {
  const hostname = hostFrom(source);
  if (hostMatchesAny(hostname, gap.requiredHosts || [])) return 'required_primary';
  if (hostMatchesAny(hostname, gap.blockedHosts || [])) return 'reprint';
  if (matchesAnyHost(hostname, PRIMARY_HOST_PATTERNS) || PRIMARY_TITLE.test(titleText(source))) {
    return 'other_primary';
  }
  if (matchesAnyHost(hostname, SPECIALIST_HOST_PATTERNS)) return 'specialist';
  if (matchesAnyHost(hostname, MAINSTREAM_HOST_PATTERNS)) return 'mainstream';
  if (matchesAnyHost(hostname, REPRINT_HOST_PATTERNS)) return 'reprint';
  if (matchesAnyHost(hostname, UGC_HOST_PATTERNS)) return 'ugc';
  return 'mainstream';
}

export function isPrimaryTier(tier) {
  return tier === 'required_primary' || tier === 'other_primary';
}

export function decorateCandidate(source = {}, gap = {}, extras = {}) {
  const hostname = hostFrom(source);
  const tier = extras.tier || classifySourceTier(source, gap);
  return {
    ...source,
    hostname,
    registrableDomain: extras.registrableDomain || registrableDomain(hostname),
    sourceType: extras.sourceType || tier,
    tier,
  };
}

export function requiredHostQueries(gap, { alreadySearched = [] } = {}) {
  const searched = new Set((alreadySearched || []).map((query) => String(query || '').trim().toLowerCase()));
  return (gap?.requiredHosts || [])
    .map((host) => siteQueryForHost(host, gap.question))
    .filter((query) => query && !searched.has(query.toLowerCase()));
}

export function selectReads({
  candidates = [],
  gap = {},
  readSourceIds = new Set(),
  failedIds = new Set(),
  skipHostnames = new Set(),
  count = 3,
  maxPerHostname = 2,
} = {}) {
  const unread = [];
  const hostnameCounts = new Map();
  for (const raw of candidates) {
    const id = raw.id || raw.url;
    if (!id || readSourceIds.has(id) || failedIds.has(id)) continue;
    if (raw.status && !['unread', 'candidate'].includes(raw.status)) continue;
    if (gap.id && raw.gapId && raw.gapId !== gap.id && raw.tier !== 'required_primary') {
      // Still allow required-primary hosts for the current gap even if discovered under another gap.
    }
    const decorated = decorateCandidate(raw, gap);
    if (hostMatchesAny(decorated.hostname, gap.blockedHosts || [])) {
      continue;
    }
    if (decorated.hostname && skipHostnames.has(decorated.hostname) && decorated.tier !== 'required_primary') {
      continue;
    }
    const hostCount = hostnameCounts.get(decorated.hostname) || 0;
    if (decorated.hostname && hostCount >= maxPerHostname) continue;
    hostnameCounts.set(decorated.hostname, hostCount + 1);
    unread.push(decorated);
  }

  unread.sort((left, right) => {
    const requiredDelta = Number(right.tier === 'required_primary') - Number(left.tier === 'required_primary');
    if (requiredDelta) return requiredDelta;
    const tierDelta = (TIER_RANK[left.tier] ?? 9) - (TIER_RANK[right.tier] ?? 9);
    if (tierDelta) return tierDelta;
    const rerankDelta = (right.rerank?.score || right.rerankScore || 0) - (left.rerank?.score || left.rerankScore || 0);
    if (rerankDelta) return rerankDelta;
    return (right.freq || 0) - (left.freq || 0);
  });

  const selected = [];
  const seenHosts = new Set();
  const seenDomains = new Set();
  for (const candidate of unread) {
    if (selected.length >= count) break;
    if (candidate.hostname && seenHosts.has(candidate.hostname) && candidate.tier !== 'required_primary') continue;
    if (candidate.registrableDomain && seenDomains.has(candidate.registrableDomain) && selected.length >= 1 && candidate.tier !== 'required_primary') {
      continue;
    }
    if (candidate.hostname) seenHosts.add(candidate.hostname);
    if (candidate.registrableDomain) seenDomains.add(candidate.registrableDomain);
    selected.push({
      ...candidate,
      selectReason: candidate.tier === 'required_primary' ? 'required_host' : `tier_${candidate.tier}`,
    });
  }
  if (!selected.length && unread.length) selected.push({ ...unread[0], selectReason: 'fallback_only_unread' });
  return selected;
}

export function independentBodyDomains(sources = []) {
  const domains = new Set();
  for (const source of sources) {
    const hostname = hostFrom(source);
    const domain = registrableDomain(hostname);
    if (domain) domains.add(domain);
  }
  return domains;
}
