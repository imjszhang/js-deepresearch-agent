import { classifyResearchQuery } from './exploratory-sufficiency.mjs';

const FRESHNESS = /\b(latest|current|today|recent|newest|as of|up to date)\b|目前|当前|最新|最近|截至|时效/i;
const COMPLETENESS = /\b(complete|comprehensive|full picture|due diligence)\b|尽调|全面|完整|清单/i;
const PLURALITY = /\b(compare|versus|vs\.?|comparison|both|multiple)\b|各方|对比|比较/i;
const ATTRIBUTION = /\b(who|author|source|according to|attribution)\b|来源|出处|谁/i;
const PRIMARY_SOURCE = /\b(official|primary|filing|prospectus|10-k|10-q|annual report|regulatory|disclosure|sec|hkex)\b|招股|年报|监管|披露|一手|官方|港交所|上交所|深交所/i;
const NUMERIC = /\b(revenue|profit|margin|market cap|valuation|shareholding)\b|营收|收入|利润|毛利|市值|持股|占比|数字|金额|%|％/i;
const DECISION = /\b(invest|investment|should i|buy|sell|decision|due diligence)\b|投资|尽调|决策|能否|值不值得/i;
const FILING = /\b(prospectus|annual report|10-k|10-q|filing)\b|招股|年报|半年报|监管披露/i;
const HKEX = /\b(hkex|hkexnews|h-?share)\b|港交所|港股/i;
const SEC = /\b(sec\.gov|edgar|10-k|10-q|s-1)\b/i;
const SSE = /sse\.com\.cn|上交所|上海证券交易所/i;
const SZSE = /szse\.cn|深交所|深圳证券交易所/i;

const HOST_IN_QUERY = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|hk|cn|uk|jp|ai|info)\b/gi;
const FILE_EXT_HOSTS = /\.(cpp|js|ts|py|md|pdf|exe|zip|png|jpg)$/i;

export const PROFILE_FLAGS = Object.freeze([
  'freshness',
  'completeness',
  'plurality',
  'attribution',
  'primary_source',
  'numeric',
  'decision_critical',
]);

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function inferRequiredHosts(query = '') {
  const text = String(query || '');
  const hosts = [];
  if (HKEX.test(text) || (FILING.test(text) && /港|hk|025\d{2}|股票代码/i.test(text))) {
    hosts.push('hkexnews.hk', 'hkex.com.hk');
  }
  if (SEC.test(text)) hosts.push('sec.gov');
  if (SSE.test(text)) hosts.push('sse.com.cn');
  if (SZSE.test(text)) hosts.push('szse.cn');
  const mentioned = text.match(HOST_IN_QUERY) || [];
  for (const host of mentioned) {
    const cleaned = host.toLowerCase().replace(/^www\./, '');
    if (cleaned && !FILE_EXT_HOSTS.test(cleaned)) hosts.push(cleaned);
  }
  return unique(hosts);
}

export function inferPreferredHosts(query = '', requiredHosts = []) {
  const text = String(query || '');
  const preferred = [...requiredHosts];
  if (FILING.test(text) || DECISION.test(text) || PRIMARY_SOURCE.test(text)) {
    preferred.push('hkexnews.hk', 'sec.gov', 'sse.com.cn', 'szse.cn');
  }
  return unique(preferred);
}

export function inferResearchProfile(query = {}) {
  const text = typeof query === 'string' ? query : String(query?.query || '');
  const shape = classifyResearchQuery(text);
  const flags = {
    freshness: FRESHNESS.test(text),
    completeness: COMPLETENESS.test(text),
    plurality: PLURALITY.test(text) || shape.kind === 'comparison',
    attribution: ATTRIBUTION.test(text),
    primary_source: PRIMARY_SOURCE.test(text) || FILING.test(text),
    numeric: NUMERIC.test(text),
    decision_critical: DECISION.test(text) || FILING.test(text),
  };
  const requiredHosts = inferRequiredHosts(text);
  const preferredHosts = inferPreferredHosts(text, requiredHosts);
  const requiredSourceTypes = [];
  if (flags.primary_source || FILING.test(text)) requiredSourceTypes.push('primary_filing');
  if (flags.numeric) requiredSourceTypes.push('numeric');
  const minIndependentSources = flags.plurality || flags.decision_critical || flags.primary_source || shape.kind === 'open'
    ? 2
    : 1;
  return {
    query: text,
    queryKind: shape.kind,
    subjects: shape.subjects,
    flags,
    requiredHosts,
    preferredHosts,
    requiredSourceTypes,
    minIndependentSources,
    maxAgeDays: flags.freshness ? 365 : null,
    method: 'rules',
  };
}

export function mergeProfilePlan(base, plan = {}) {
  const next = {
    ...base,
    requiredHosts: unique([...(base.requiredHosts || []), ...(plan.requiredHosts || [])]),
    preferredHosts: unique([...(base.preferredHosts || []), ...(plan.preferredHosts || [])]),
    requiredSourceTypes: unique([...(base.requiredSourceTypes || []), ...(plan.requiredSourceTypes || [])]),
    minIndependentSources: Math.max(
      Number(base.minIndependentSources) || 1,
      Number(plan.minIndependentSources) || 0,
    ),
    plannedGaps: Array.isArray(plan.gaps) ? plan.gaps : [],
    method: plan.method ? `${base.method}+${plan.method}` : base.method,
  };
  for (const flag of PROFILE_FLAGS) {
    if (plan.flags && plan.flags[flag] === true) next.flags[flag] = true;
  }
  return next;
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

export async function planResearchProfile({ llm, query, profile, signal } = {}) {
  if (!llm?.complete) return profile;
  try {
    const response = await llm.complete({
      purpose: 'research_profile',
      signal,
      temperature: 0,
      maxTokens: 500,
      messages: [{
        role: 'system',
        content: [
          'Infer a research evidence profile. Do not invent a fixed industry questionnaire.',
          'Return JSON only: {"flags":{"freshness":false,"completeness":false,"plurality":false,"attribution":false,"primary_source":false,"numeric":false,"decision_critical":false},"requiredHosts":[],"preferredHosts":[],"requiredSourceTypes":[],"minIndependentSources":1,"gaps":[{"question":"...","priority":"critical|normal","requiredHosts":[]}]}',
          'requiredHosts must be real hostnames implied by the query (exchanges, regulators, official docs). Leave empty when unknown.',
        ].join('\n'),
      }, {
        role: 'user',
        content: query,
      }],
    });
    const parsed = extractJson(response);
    if (!parsed) return profile;
    return mergeProfilePlan(profile, { ...parsed, method: 'llm' });
  } catch {
    return profile;
  }
}

export function createRootGap(query, profile = {}) {
  return createGapRecord({
    id: 'gap-1',
    question: query,
    priority: 'critical',
    depth: 0,
    profile,
  });
}

export function createGapRecord({
  id,
  question,
  priority = 'normal',
  depth = 1,
  profile = {},
  requiredHosts,
  preferredHosts,
  requiredSourceTypes,
  minIndependentSources,
  maxAgeDays,
} = {}) {
  return {
    id,
    question: String(question || '').trim(),
    status: 'open',
    priority,
    depth,
    requiredSourceTypes: unique(requiredSourceTypes ?? profile.requiredSourceTypes),
    requiredHosts: unique(requiredHosts ?? (priority === 'critical' ? profile.requiredHosts : [])),
    preferredHosts: unique(preferredHosts ?? profile.preferredHosts),
    blockedHosts: [],
    maxAgeDays: maxAgeDays ?? profile.maxAgeDays ?? null,
    minIndependentSources: Number(minIndependentSources ?? profile.minIndependentSources) || 1,
    searchedQueries: [],
    candidateUrls: [],
    readSourceIds: [],
    evidencePassageIds: [],
    blockedReason: null,
  };
}
