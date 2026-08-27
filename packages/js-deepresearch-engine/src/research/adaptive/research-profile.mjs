import { extractHostnamesFromText, normalizeHost } from './hostname-policy.mjs';
import { classifyResearchQuery, isOrthogonalGap } from './exploratory-sufficiency.mjs';

const REQUIREMENT_KEYS = [
  'freshness',
  'completeness',
  'plurality',
  'attribution',
  'primary_source',
  'numeric',
  'decision_critical',
];

const FRESHNESS = /\b(latest|current|today|recent|newest|as of|now|ytd|updated)\b|目前|当前|最新|最近|截至|今天|本年|今年/;
const COMPLETENESS = /\b(complete|comprehensive|full|entire|all|due diligence|diligence|audit)\b|全面|完整|尽调|尽职调查|盘点/;
const PLURALITY = /\b(compare|versus|vs\.?|comparison|both|between)\b|对比|比较|两者/;
const ATTRIBUTION = /\b(who|owner|ownership|shareholder|controlling|founder|issuer|author)\b|谁|控股|股东|实控|创始人|归属/;
const PRIMARY_SOURCE = /\b(official|filing|filings|prospectus|10-k|10-q|20-f|annual report|sec|hkex|primary source|source of record)\b|官方|一手|招股书|年报|监管披露|交易所|港交所|上交所|深交所/;
const NUMERIC = /\b(revenue|profit|margin|valuation|market cap|arr|price|percent|%|\$|usd|hkd)\b|营收|收入|利润|毛利|净利|估值|市值|占比|增长率/;
const DECISION = /\b(invest|investment|should i|buy|sell|due diligence|decision|recommend)\b|投资|尽调|买入|卖出|决策|是否值得/;
const LISTING = /\b(ipo|listing|listed|prospectus|annual report|20-f|10-k)\b|上市|招股|年报|监管披露|港股|h股|a股/;

const VENUE_HOSTS = [
  { pattern: /\bhkex\b|hkexnews|港交所|香港交易所|\bh股\b|\bhkex\b/i, host: 'hkexnews.hk' },
  { pattern: /\bsec\b|\bedgar\b|\b10-k\b|\b10-q\b|\b20-f\b/i, host: 'sec.gov' },
  { pattern: /上交所|sse\.com/i, host: 'sse.com.cn' },
  { pattern: /深交所|szse/i, host: 'szse.cn' },
  { pattern: /\bnasdaq\b/i, host: 'nasdaq.com' },
];

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function inferRequirements(query) {
  const text = String(query || '');
  const shape = classifyResearchQuery(text);
  const requirements = {
    freshness: FRESHNESS.test(text),
    completeness: COMPLETENESS.test(text),
    plurality: PLURALITY.test(text) || shape.kind === 'comparison',
    attribution: ATTRIBUTION.test(text),
    primary_source: PRIMARY_SOURCE.test(text),
    numeric: NUMERIC.test(text),
    decision_critical: DECISION.test(text),
  };
  if (requirements.decision_critical && LISTING.test(text)) {
    requirements.primary_source = true;
    requirements.numeric = true;
    requirements.attribution = requirements.attribution || /控股|股东|control|owner/i.test(text);
  }
  if (shape.kind === 'comparison') requirements.plurality = true;
  return { requirements, shape };
}

function inferHosts(query) {
  const text = String(query || '');
  const hosts = extractHostnamesFromText(text);
  for (const venue of VENUE_HOSTS) {
    if (venue.pattern.test(text)) hosts.push(venue.host);
  }
  return unique(hosts.map(normalizeHost));
}

function requiredSourceTypesFor(requirements) {
  if (requirements.primary_source || requirements.decision_critical) return ['primary'];
  return [];
}

export function inferResearchProfile(query) {
  const { requirements, shape } = inferRequirements(query);
  const requiredHosts = inferHosts(query);
  const minIndependentSources = requirements.plurality || requirements.completeness || requirements.decision_critical
    ? 2
    : (shape.kind === 'definitional' ? 1 : 2);
  return {
    query: String(query || ''),
    kind: shape.kind,
    subjects: shape.subjects,
    requirements,
    requiredHosts,
    preferredHosts: requiredHosts,
    requiredSourceTypes: requiredSourceTypesFor(requirements),
    maxAgeDays: requirements.freshness ? 365 : null,
    minIndependentSources,
    method: 'rules',
  };
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function mergeProfile(base, planned) {
  if (!planned || typeof planned !== 'object') return base;
  const requirements = { ...base.requirements };
  for (const key of REQUIREMENT_KEYS) {
    if (planned.requirements?.[key] === true) requirements[key] = true;
    if (Array.isArray(planned.requirements) && planned.requirements.includes(key)) requirements[key] = true;
  }
  const requiredHosts = unique([
    ...base.requiredHosts,
    ...(planned.requiredHosts || []).map(normalizeHost),
  ]).filter((host) => host.includes('.'));
  return {
    ...base,
    requirements,
    requiredHosts,
    preferredHosts: unique([...base.preferredHosts, ...requiredHosts]),
    requiredSourceTypes: unique([
      ...base.requiredSourceTypes,
      ...(planned.requiredSourceTypes || []),
    ]),
    plannedGaps: Array.isArray(planned.gaps) ? planned.gaps : [],
    method: planned.requirements || planned.gaps ? 'rules_then_llm' : base.method,
  };
}

export async function planResearchProfile({ query, llm, signal } = {}) {
  const base = inferResearchProfile(query);
  if (!llm?.complete) return base;
  try {
    const response = await llm.complete({
      purpose: 'research_profile',
      signal,
      temperature: 0,
      maxTokens: 400,
      messages: [{
        role: 'system',
        content: [
          'Infer research evidence requirements from the query.',
          'Do not invent company-specific slot catalogs.',
          `Known requirement keys: ${REQUIREMENT_KEYS.join(', ')}.`,
          'requiredHosts must be real hostnames mentioned or implied by a disclosure venue in the query.',
          'Return JSON only: {"requirements":["primary_source"],"requiredHosts":["example.com"],"gaps":[{"question":"...","priority":"critical","requiredHosts":[]}]}',
        ].join('\n'),
      }, { role: 'user', content: String(query || '') }],
    });
    return mergeProfile(base, extractJson(response));
  } catch {
    return base;
  }
}

export function profileGapDefaults(profile = {}) {
  return {
    requiredSourceTypes: profile.requiredSourceTypes || [],
    requiredHosts: profile.requiredHosts || [],
    preferredHosts: profile.preferredHosts || [],
    blockedHosts: [],
    maxAgeDays: profile.maxAgeDays,
    minIndependentSources: Number(profile.minIndependentSources) || 1,
  };
}

export function plannedOrthogonalGaps(profile, existingGaps = []) {
  return (profile?.plannedGaps || [])
    .map((item) => ({
      question: String(item?.question || '').trim(),
      priority: item?.priority === 'critical' ? 'critical' : 'normal',
      requiredHosts: unique(item?.requiredHosts || []),
      requiredSourceTypes: unique(item?.requiredSourceTypes || profile.requiredSourceTypes || []),
    }))
    .filter((item) => item.question && isOrthogonalGap(existingGaps, item.question));
}
