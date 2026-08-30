import { sourceDiversityKey } from '../source-candidates.mjs';

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'gov.hk',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'com.au', 'net.au', 'org.au', 'co.nz',
]);

const PRIMARY_HOST_PATTERNS = [
  /(^|\.)github\.com$/,
  /(^|\.)gitlab\.com$/,
  /(^|\.)codeberg\.org$/,
  /(^|\.)arxiv\.org$/,
  /(^|\.)doi\.org$/,
  /(^|\.)gov(\.[a-z.]+)?$/,
  /(^|\.)edu(\.[a-z.]+)?$/,
  /(^|\.)hkexnews\.hk$/,
  /(^|\.)hkex\.com\.hk$/,
  /(^|\.)sec\.gov$/,
  /(^|\.)sse\.com\.cn$/,
  /(^|\.)szse\.cn$/,
  /\.readthedocs\.io$/,
  /^docs\./,
  /^developer\./,
];

const SPECIALIST_HOST_PATTERNS = [
  /(^|\.)wikipedia\.org$/,
  /(^|\.)ietf\.org$/,
  /(^|\.)w3\.org$/,
  /(^|\.)acm\.org$/,
  /(^|\.)ieee\.org$/,
];

const MAINSTREAM_HOST_PATTERNS = [
  /(^|\.)reuters\.com$/,
  /(^|\.)bloomberg\.com$/,
  /(^|\.)ft\.com$/,
  /(^|\.)wsj\.com$/,
  /(^|\.)nytimes\.com$/,
  /(^|\.)bbc\.(com|co\.uk)$/,
  /(^|\.)xinhuanet\.com$/,
  /(^|\.)people\.com\.cn$/,
  /(^|\.)caixin\.com$/,
  /(^|\.)scmp\.com$/,
];

const REPRINT_HOST_PATTERNS = [
  /(^|\.)yahoo\.com$/,
  /(^|\.)msn\.com$/,
  /(^|\.)news\.google\.com$/,
  /(^|\.)163\.com$/,
  /(^|\.)qq\.com$/,
  /(^|\.)sohu\.com$/,
  /(^|\.)sina\.com\.cn$/,
];

const UGC_HOST_PATTERNS = [
  /(^|\.)zhihu\.com$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)medium\.com$/,
  /(^|\.)csdn\.net$/,
  /(^|\.)cnblogs\.com$/,
  /(^|\.)substack\.com$/,
  /(^|\.)wordpress\.com$/,
  /(^|\.)blogger\.com$/,
];

const TIER_RANK = Object.freeze({
  required_primary: 0,
  other_primary: 1,
  specialist: 2,
  mainstream: 3,
  reprint: 4,
  ugc: 5,
  unknown: 6,
});

export function parseUrlParts(url) {
  try {
    const parsed = new URL(String(url || ''));
    return {
      hostname: String(parsed.hostname || '').toLowerCase().replace(/\.$/, ''),
      pathname: parsed.pathname || '/',
    };
  } catch {
    return null;
  }
}

export function stripLeadingWww(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function hostnameOf(url) {
  const parts = parseUrlParts(url);
  return parts ? stripLeadingWww(parts.hostname) : '';
}

export function hostnamesMatch(urlHostname, policyHost) {
  const left = stripLeadingWww(urlHostname);
  const right = stripLeadingWww(policyHost);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

export function registrableDomain(hostname) {
  const stripped = stripLeadingWww(hostname);
  if (!stripped) return '';
  const labels = stripped.split('.').filter(Boolean);
  if (labels.length <= 2) return stripped;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function registrableDomainFromUrl(url) {
  const host = hostnameOf(url);
  return host ? registrableDomain(host) : '';
}

function matchesAny(hostname, patterns) {
  return patterns.some((pattern) => pattern.test(hostname));
}

export function classifySourceTier(source = {}, gap = {}) {
  const host = hostnameOf(source.url || source.id);
  if (!host) return 'unknown';
  const required = gap.requiredHosts || [];
  if (required.some((item) => hostnamesMatch(host, item))) return 'required_primary';
  if (matchesAny(host, PRIMARY_HOST_PATTERNS) || source.sourceType === 'primary') return 'other_primary';
  if (matchesAny(host, SPECIALIST_HOST_PATTERNS)) return 'specialist';
  if (matchesAny(host, UGC_HOST_PATTERNS)) return 'ugc';
  if (matchesAny(host, REPRINT_HOST_PATTERNS)) return 'reprint';
  if (matchesAny(host, MAINSTREAM_HOST_PATTERNS)) return 'mainstream';
  if (source.sourceType === 'ugc') return 'ugc';
  if (source.sourceType === 'reprint') return 'reprint';
  return 'unknown';
}

export function sourceTierRank(tier) {
  return TIER_RANK[tier] ?? TIER_RANK.unknown;
}

export function isRequiredHostSource(source, gap = {}) {
  const host = hostnameOf(source?.url || source?.id);
  return (gap.requiredHosts || []).some((item) => hostnamesMatch(host, item));
}

export function isBlockedHostSource(source, gap = {}) {
  const host = hostnameOf(source?.url || source?.id);
  return (gap.blockedHosts || []).some((item) => hostnamesMatch(host, item));
}

export function mediaCannotVerifyRequiredPrimary(source, gap = {}) {
  if (!(gap.requiredHosts || []).length && !(gap.requiredSourceTypes || []).includes('primary_filing')) {
    return false;
  }
  const tier = classifySourceTier(source, gap);
  return ['mainstream', 'reprint', 'ugc', 'unknown'].includes(tier);
}

const SUBJECT_STOPS = new Set([
  '截至', '股权', '结构', '核心', '模型', '收入', '竞争', '格局', '监管', '披露',
  '优先', '官网', '原文', '投资', '尽调', '目前', '当前', '最新', '全面', '完整',
  '清单', '官方', '一手', '年报', '招股', '半年报', '对比', '比较', '各方',
  '港交所', '上交所', '深交所', '招股书', '营收', '控股', '股东', '时效',
  '最近', '公司', '集团', '股份', '有限', '科技',
]);

const FILING_LIKE = /年报|半年报|招股|prospectus|10-k|10-q|年度报告|招股说明书|filing|公告/i;

function uniqueTerms(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function isSubjectStop(token) {
  if (SUBJECT_STOPS.has(token)) return true;
  for (const stop of SUBJECT_STOPS) {
    if (stop.length >= 2 && token.includes(stop)) return true;
  }
  return false;
}

export function extractQuerySubjects(query = '') {
  const text = String(query || '');
  const subjects = [];
  for (const token of text.match(/[\u4e00-\u9fff]{2,6}/g) || []) {
    const trimmed = token.replace(/(公司|集团|科技|股份|有限)$/u, '');
    if (trimmed.length >= 2 && !isSubjectStop(trimmed)) subjects.push(trimmed);
  }
  subjects.push(...(text.match(/\b[A-Z][A-Za-z0-9.+-]{1,}\b/g) || []));
  subjects.push(...(text.match(/\b\d{4,6}\b/g) || []));
  return uniqueTerms(subjects).slice(0, 8);
}

export function documentMatchesQuerySubject(source = {}, query = '') {
  const subjects = extractQuerySubjects(query);
  if (!subjects.length) return true;
  const title = String(source.title || '');
  const body = String(source.content || source.summary || source.snippet || '').slice(0, 500);
  const hay = `${title}\n${body}`.toLowerCase();
  if (subjects.some((subject) => hay.includes(String(subject).toLowerCase()))) return true;
  if (!FILING_LIKE.test(`${title} ${body}`)) return true;
  return false;
}

export function gapHasPolicyHosts(gap = {}) {
  return Boolean((gap?.requiredHosts || []).length);
}

export function siteQueryTermVariants(query = '') {
  const text = String(query || '').trim();
  const subjects = extractQuerySubjects(text);
  const cjk = subjects.filter((item) => /[\u4e00-\u9fff]/.test(item));
  const latin = subjects.filter((item) => /[A-Za-z]/.test(item));
  const tickers = subjects.filter((item) => /^\d{4,6}$/.test(item));
  const compact = [cjk[0], tickers[0], latin[0]].filter(Boolean).join(' ');
  const cjkTicker = [cjk[0], tickers[0]].filter(Boolean).join(' ');
  const slice8 = text.replace(/\s+/g, ' ').slice(0, 8);
  const slice12 = text.replace(/\s+/g, ' ').slice(0, 12);
  return uniqueTerms([compact, cjkTicker, cjk[0], latin[0], tickers[0], slice8, slice12]);
}

export function shortSearchTerms(query = '', { maxChars = 12 } = {}) {
  const variants = siteQueryTermVariants(query);
  if (variants[0]) return variants[0];
  return String(query || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function nextUnusedSearchAngles(query, searchedQueries = [], { limit = 2 } = {}) {
  const searched = new Set((searchedQueries || []).map(String));
  const out = [];
  for (const terms of siteQueryTermVariants(query)) {
    if (!terms || searched.has(terms)) continue;
    out.push(terms);
    if (out.length >= limit) return out;
  }
  return out;
}

export function nextUnusedSiteQueries(gap, query, searchedQueries = [], { limit = 2 } = {}) {
  const hosts = uniqueTerms(gap?.requiredHosts || []);
  if (!hosts.length) return [];
  const searched = new Set((searchedQueries || []).map(String));
  const variants = siteQueryTermVariants(query || gap?.question);
  const out = [];
  for (const terms of variants) {
    for (const host of hosts) {
      const next = `site:${host} ${terms}`.trim();
      if (searched.has(next)) continue;
      out.push(next);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function buildSiteHostQueries(gap, extraTerms = '', options = {}) {
  const hosts = uniqueTerms(gap?.requiredHosts || []);
  const terms = String(extraTerms || '').trim() || shortSearchTerms(options.query || gap?.question || '');
  return hosts.map((host) => `site:${host} ${terms}`.trim());
}

export function independentDomainsFromSources(sources = []) {
  return new Set(
    (sources || [])
      .map((source) => registrableDomainFromUrl(source.url || source.id))
      .filter(Boolean),
  );
}

export function selectReadsByPolicy({
  candidates = [],
  gap = {},
  alreadyReadHostnames = new Set(),
  maxPerHostname = 2,
  minCount = 2,
  maxCount = 5,
} = {}) {
  const ranked = [...candidates]
    .filter((candidate) => candidate && !isBlockedHostSource(candidate, gap))
    .map((candidate) => {
      const tier = candidate.tier || classifySourceTier(candidate, gap);
      return {
        ...candidate,
        hostname: candidate.hostname || hostnameOf(candidate.url || candidate.id),
        diversityKey: candidate.diversityKey || sourceDiversityKey(candidate),
        registrableDomain: candidate.registrableDomain || registrableDomainFromUrl(candidate.url || candidate.id),
        tier,
        tierRank: sourceTierRank(tier),
        rerankScore: Number(candidate.rerank?.score ?? candidate.rerankScore ?? 0) || 0,
      };
    })
    .sort((left, right) => {
      if (left.tierRank !== right.tierRank) return left.tierRank - right.tierRank;
      if (right.rerankScore !== left.rerankScore) return right.rerankScore - left.rerankScore;
      return (right.freq || 0) - (left.freq || 0);
    });

  const picks = [];
  const seenHosts = new Set();
  const seenDomains = new Set();
  const hostCounts = new Map();

  for (const candidate of ranked) {
    const host = candidate.hostname;
    const channel = candidate.diversityKey || sourceDiversityKey(candidate);
    const domain = candidate.registrableDomain;
    if (channel && alreadyReadHostnames.has(channel) && candidate.tier !== 'required_primary') continue;
    if (host && alreadyReadHostnames.has(host) && candidate.tier !== 'required_primary') continue;
    if (channel && seenHosts.has(channel)) continue;
    if (channel && (hostCounts.get(channel) || 0) >= maxPerHostname) continue;
    if (domain && seenDomains.has(domain) && picks.length >= minCount && candidate.tier !== 'required_primary') {
      continue;
    }
    picks.push({
      ...candidate,
      selectReason: candidate.tier === 'required_primary' ? 'required_host' : `tier_${candidate.tier}`,
    });
    if (channel) {
      seenHosts.add(channel);
      hostCounts.set(channel, (hostCounts.get(channel) || 0) + 1);
    }
    if (domain) seenDomains.add(domain);
    if (picks.length >= maxCount) break;
  }

  if (!picks.length && ranked.length) {
    picks.push({ ...ranked[0], selectReason: 'fallback_first_unread' });
  }
  return picks.slice(0, Math.max(minCount, picks.length === 1 ? 1 : Math.min(maxCount, Math.max(minCount, picks.length))));
}
