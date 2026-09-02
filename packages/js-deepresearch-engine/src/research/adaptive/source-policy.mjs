import { isFileSourceUrl, sourceDiversityKey } from '../source-candidates.mjs';
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

export function siteHostsFromQuery(query = '') {
  return uniqueTerms(
    [...String(query || '').matchAll(/(?:^|\s)site:([^\s]+)/gi)]
      .map((match) => stripLeadingWww(String(match[1] || '').replace(/^https?:\/\//i, '').split('/')[0])),
  );
}

export function sourceMatchesSiteQuery(source = {}, query = '') {
  const hosts = siteHostsFromQuery(query);
  if (!hosts.length) return true;
  const hostname = hostnameOf(source.url || source.id);
  return hosts.some((host) => hostnamesMatch(hostname, host));
}

export function isExternalRerankProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return Boolean(value) && !['disabled', 'rules', 'none', 'local'].includes(value);
}

function stripStandaloneAiSuffix(value) {
  return String(value || '').replace(/\s+AI$/i, '').trim();
}

function entityAliases(entities = []) {
  return uniqueTerms((entities || []).flatMap((entity) => {
    const value = String(entity || '').trim();
    if (!value) return [];
    const compact = value.replace(/\s+/g, '');
    const withoutSuffix = compact.replace(/(股份有限公司|有限责任公司|有限公司|集团|公司)$/u, '');
    const withoutStandaloneAi = stripStandaloneAiSuffix(value);
    const cjkAliases = value.match(/[\p{Script=Han}]{2,}/gu) || [];
    const latinAliases = (value.match(/[a-z][a-z0-9.-]{2,}/gi) || [])
      .filter((item) => !['company', 'limited', 'technology'].includes(item.toLowerCase()));
    return [value, compact, withoutSuffix, withoutStandaloneAi, ...cjkAliases, ...latinAliases]
      .map((item) => item.replace(/(股份有限公司|有限责任公司|有限公司|集团|公司)$/u, ''))
      .map((item) => stripStandaloneAiSuffix(item))
      .filter((item) => item.length >= 2);
  }));
}

export function resolveEntityAliases(entities = [], extraAliases = []) {
  return uniqueTerms([...entityAliases(entities), ...extraAliases]);
}

export function matchEntityAlias(source = {}, entities = [], extraAliases = []) {
  const aliases = resolveEntityAliases(entities, extraAliases);
  if (!aliases.length) return { match: true, matchedAlias: null };
  const haystack = [
    source.title,
    source.snippet,
    source.summary,
    source.content,
    source.publisher,
  ].filter(Boolean).join('\n').normalize('NFKC').toLowerCase();
  const matchedAlias = aliases.find((alias) => haystack.includes(alias.normalize('NFKC').toLowerCase())) || null;
  return { match: Boolean(matchedAlias), matchedAlias };
}

export function sourceMatchesEntities(source = {}, entities = [], extraAliases = []) {
  return matchEntityAlias(source, entities, extraAliases).match;
}

export function evaluateSourceRelevance(source = {}, {
  gap = {},
  query = '',
  entities = [],
  entityAliases: extraAliases = [],
  enabled = true,
  enforceEntity = true,
  minRerankScore = 0.01,
  rerankProvider = source?.rerank?.provider || null,
  externalRerankEnabled = null,
  allowRequiredHostProbe = true,
} = {}) {
  const rawRerankScore = source?.rerank?.score ?? source?.rerankScore;
  const rerankScore = rawRerankScore == null ? null : Number(rawRerankScore);
  const threshold = Number(minRerankScore);
  const externalEnabled = externalRerankEnabled == null
    ? isExternalRerankProvider(rerankProvider)
    : Boolean(externalRerankEnabled);
  const rerankEvaluated = externalEnabled && Number.isFinite(rerankScore);
  const siteMatch = sourceMatchesSiteQuery(source, query);
  const entity = matchEntityAlias(source, entities, extraAliases);
  const requiredHostProbe = allowRequiredHostProbe && isRequiredHostSource(source, gap);
  const pending = externalEnabled && !rerankEvaluated;
  const base = {
    accepted: true,
    reasonCode: requiredHostProbe
      ? 'required_host_probe'
      : (rerankEvaluated ? 'relevance_accepted' : (pending ? 'rerank_pending' : 'rerank_not_evaluated')),
    entityMatch: entity.match,
    matchedAlias: entity.matchedAlias,
    siteMatch,
    rerankScore: Number.isFinite(rerankScore) ? rerankScore : null,
    threshold: Number.isFinite(threshold) ? threshold : null,
    requiredHostProbe,
  };
  if (!enabled) return { ...base, reasonCode: 'relevance_disabled' };
  if (!siteMatch) return { ...base, accepted: false, reasonCode: 'site_constraint_violation' };
  if (enforceEntity && !entity.match && !requiredHostProbe) {
    return { ...base, accepted: false, reasonCode: 'entity_mismatch' };
  }
  if (pending && !requiredHostProbe) {
    return { ...base, accepted: false, reasonCode: 'rerank_pending' };
  }
  const shouldApplyThreshold = externalEnabled
    && Number.isFinite(rerankScore) && Number.isFinite(threshold);
  if (shouldApplyThreshold && rerankScore < threshold && !requiredHostProbe) {
    return { ...base, accepted: false, reasonCode: 'rerank_below_threshold' };
  }
  return base;
}

export function requiredHostCoverage(sources = [], gap = {}) {
  const required = uniqueTerms(gap?.requiredHosts || []);
  const read = required.filter((host) => (
    (sources || []).some((source) => hostnamesMatch(hostnameOf(source?.url || source?.id), host))
  ));
  const missing = required.filter((host) => !read.includes(host));
  const mode = gap?.requiredHostMode === 'all' ? 'all' : 'any';
  return {
    mode,
    read,
    missing,
    satisfied: !required.length || (mode === 'all' ? missing.length === 0 : read.length > 0),
  };
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
  const assessed = source.assessment?.evidenceTier;
  if (assessed && ['other_primary', 'specialist', 'mainstream', 'reprint', 'ugc', 'unknown'].includes(assessed)) {
    return assessed;
  }
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

export function documentMatchesQuerySubject(source = {}, query = '', extras = {}) {
  const title = String(source.title || '');
  const body = String(source.content || source.summary || source.snippet || '').slice(0, 500);
  const hay = `${title}\n${body}`.toLowerCase();
  const structured = resolveEntityAliases(extras.entities || [], extras.entityAliases || []);
  if (structured.length && matchEntityAlias(source, extras.entities || [], extras.entityAliases || []).match) {
    return true;
  }
  const subjects = extractQuerySubjects(query);
  if (subjects.some((subject) => hay.includes(String(subject).toLowerCase()))) return true;
  if (!FILING_LIKE.test(`${title} ${body}`)) return true;
  return false;
}

export function gapHasPolicyHosts(gap = {}) {
  return Boolean((gap?.requiredHosts || []).length);
}

function publicScopeField(value) {
  const text = String(value || '').trim();
  if (!text || /_/.test(text)) return '';
  return text;
}

function asScopeTexts(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => asScopeTexts(item));
  const text = String(value).trim();
  return text ? [text] : [];
}

function scopeTerms(texts, entities = [], extraAliases = []) {
  let scopeText = asScopeTexts(texts).join(' ').normalize('NFKC').toLowerCase();
  for (const alias of resolveEntityAliases(entities, extraAliases)) {
    scopeText = scopeText.replaceAll(alias.normalize('NFKC').toLowerCase(), ' ');
  }
  const generic = new Set([
    'what', 'does', 'work', 'topic', 'evidence', 'status', 'company', 'research',
    '如何', '情况', '公司', '研究', '证据', '状态', '最新', '历史',
  ]);
  const latin = (scopeText.match(/[a-z][a-z0-9]{3,}/g) || [])
    .filter((term) => !generic.has(term));
  const han = (scopeText.match(/[\p{Script=Han}]{2,}/gu) || []).flatMap((term) => {
    if (term.length <= 4) return [term];
    return Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2));
  }).filter((term) => !generic.has(term));
  return uniqueTerms([...latin, ...han]);
}

export function queryMatchesGapScope(query = '', gap = {}, entities = [], extraScope = [], extraAliases = []) {
  const gapTerms = scopeTerms([
    gap.question,
    publicScopeField(gap.answerSlot),
    publicScopeField(gap.claimFamily),
    ...(gap.evidenceCriteria || []).map(publicScopeField),
  ], entities, extraAliases);
  const extraTerms = scopeTerms(extraScope, entities, extraAliases);
  const normalizedQuery = String(query || '').normalize('NFKC').toLowerCase();
  if (gapTerms.some((term) => normalizedQuery.includes(term))) return true;
  if (extraTerms.some((term) => normalizedQuery.includes(term))) return true;
  // Generic slots have no distinctive terms. The planner may still pass the
  // original research question as extraScope so a translated query can match,
  // but those extra terms must not become an exclusive filter.
  return gapTerms.length === 0;
}

export function independentDomainsFromSources(sources = []) {
  return new Set(
    (sources || [])
      .map((source) => registrableDomainFromUrl(source.url || source.id))
      .filter(Boolean),
  );
}

export function listLocalCorpusChannels(settings = {}) {
  const dirs = settings?.search?.local?.dirs;
  if (!Array.isArray(dirs)) return [];
  return [...new Set(dirs.map((dir) => String(dir || '').trim()).filter(Boolean))];
}

export function inferEvidenceScope(settings = {}) {
  const engine = String(settings?.search?.engine || '').trim().toLowerCase();
  const localChannels = listLocalCorpusChannels(settings);
  const hasLocal = engine === 'local' || localChannels.length > 0;
  const hasWeb = Boolean(engine) && engine !== 'local';
  if (hasLocal && hasWeb) return 'mixed';
  if (hasLocal) return 'local';
  return 'web';
}

export function evidenceIndependenceKey(source = {}) {
  const url = source.url || source.id || '';
  if (isFileSourceUrl(url) || isFileSourceUrl(source.url)) {
    return sourceDiversityKey(source);
  }
  return registrableDomainFromUrl(url);
}

export function independentEvidenceKeysFromSources(sources = []) {
  return new Set(
    (sources || [])
      .map((source) => evidenceIndependenceKey(source))
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
  relevance = null,
} = {}) {
  const ranked = [...candidates]
    .filter((candidate) => candidate && !isBlockedHostSource(candidate, gap))
    .map((candidate) => {
      const tier = candidate.tier || classifySourceTier(candidate, gap);
      const evaluated = relevance
        ? evaluateSourceRelevance(candidate, { ...relevance, gap })
        : (candidate.relevanceDecision || null);
      const decision = evaluated ? { ...evaluated, gapId: gap.id || candidate.gapId || null } : null;
      return {
        ...candidate,
        hostname: candidate.hostname || hostnameOf(candidate.url || candidate.id),
        diversityKey: candidate.diversityKey || sourceDiversityKey(candidate),
        registrableDomain: candidate.registrableDomain || registrableDomainFromUrl(candidate.url || candidate.id),
        tier,
        tierRank: sourceTierRank(tier),
        rerankScore: candidate.rerank?.score ?? candidate.rerankScore ?? null,
        hostPreferenceBoost: (gap.preferredHosts || []).some((host) => (
          hostnamesMatch(candidate.hostname || hostnameOf(candidate.url || candidate.id), host)
        )) ? 0.15 : 0,
        relevanceDecision: decision,
      };
    })
    .filter((candidate) => candidate.relevanceDecision?.accepted !== false)
    .sort((left, right) => {
      if (left.tier === 'required_primary' && right.tier !== 'required_primary') return -1;
      if (right.tier === 'required_primary' && left.tier !== 'required_primary') return 1;
      const rightScore = right.rerankScore == null ? Number.NEGATIVE_INFINITY : Number(right.rerankScore);
      const leftScore = left.rerankScore == null ? Number.NEGATIVE_INFINITY : Number(left.rerankScore);
      const rightRank = (Number.isFinite(rightScore) ? rightScore : Number.NEGATIVE_INFINITY) + right.hostPreferenceBoost;
      const leftRank = (Number.isFinite(leftScore) ? leftScore : Number.NEGATIVE_INFINITY) + left.hostPreferenceBoost;
      if (rightRank !== leftRank) return rightRank - leftRank;
      if (left.tierRank !== right.tierRank) return left.tierRank - right.tierRank;
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
