import { classifyResearchQuery } from './exploratory-sufficiency.mjs';
import { inferEvidenceScope, listLocalCorpusChannels } from './source-policy.mjs';

const HOST_IN_QUERY = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|hk|cn|uk|jp|ai|info)\b/gi;
const FILE_EXT_HOSTS = /\.(cpp|js|ts|py|md|pdf|exe|zip|png|jpg)$/i;
const HOSTNAME_SHAPE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const KNOWN_SOURCE_TYPES = new Set(['primary_filing', 'numeric']);

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

function emptyFlags() {
  return Object.fromEntries(PROFILE_FLAGS.map((flag) => [flag, false]));
}

export function looksLikeHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host || FILE_EXT_HOSTS.test(host)) return false;
  return HOSTNAME_SHAPE.test(host);
}

export function sanitizeHosts(values) {
  return unique((values || []).map((value) => String(value || '').trim().toLowerCase().replace(/^www\./, '')).filter(looksLikeHostname));
}

export function sanitizeSourceTypes(values) {
  return unique((values || []).filter((item) => KNOWN_SOURCE_TYPES.has(String(item || '').trim())));
}

export function extractLiteralHosts(query = '') {
  const mentioned = String(query || '').match(HOST_IN_QUERY) || [];
  return sanitizeHosts(mentioned);
}

export function inferRequiredHosts(query = '') {
  return extractLiteralHosts(query);
}

export function inferPreferredHosts() {
  return [];
}

export function inferResearchProfile(query = {}, options = {}) {
  const text = typeof query === 'string' ? query : String(query?.query || '');
  const settings = options.settings || (typeof query === 'object' && query ? query.settings : undefined);
  const evidenceScope = options.evidenceScope || inferEvidenceScope(settings);
  const shape = classifyResearchQuery(text);
  return sanitizeEvidenceProfile({
    query: text,
    queryKind: shape.kind,
    subjects: shape.subjects,
    flags: emptyFlags(),
    requiredHosts: inferRequiredHosts(text),
    preferredHosts: inferPreferredHosts(text),
    requiredSourceTypes: [],
    minIndependentSources: 1,
    maxAgeDays: null,
    method: 'rules',
    evidenceScope,
  }, { evidenceScope, settings, query: text });
}

export function sanitizeEvidenceProfile(profile = {}, {
  evidenceScope,
  settings = {},
  query,
} = {}) {
  const text = String(query || profile.query || '');
  const scope = evidenceScope || profile.evidenceScope || inferEvidenceScope(settings);
  const literalHosts = new Set(extractLiteralHosts(text));
  const next = {
    ...profile,
    flags: { ...emptyFlags(), ...(profile.flags || {}) },
    requiredHosts: sanitizeHosts(profile.requiredHosts),
    preferredHosts: sanitizeHosts(profile.preferredHosts),
    requiredSourceTypes: sanitizeSourceTypes(profile.requiredSourceTypes),
    plannedGaps: sanitizePlannedGaps(profile.plannedGaps),
    evidenceScope: scope,
  };
  if (scope === 'local') {
    next.requiredHosts = next.requiredHosts.filter((host) => literalHosts.has(host));
    next.preferredHosts = next.preferredHosts.filter((host) => literalHosts.has(host));
    next.requiredSourceTypes = next.requiredSourceTypes.filter((type) => type !== 'primary_filing');
    next.plannedGaps = (next.plannedGaps || []).map((gap) => ({
      ...gap,
      requiredHosts: sanitizeHosts(gap.requiredHosts).filter((host) => literalHosts.has(host)),
      preferredHosts: sanitizeHosts(gap.preferredHosts).filter((host) => literalHosts.has(host)),
      requiredSourceTypes: sanitizeSourceTypes(gap.requiredSourceTypes).filter((type) => type !== 'primary_filing'),
    }));
    const cap = Math.max(1, listLocalCorpusChannels(settings).length);
    next.minIndependentSources = Math.min(Math.max(1, Number(next.minIndependentSources) || 1), cap);
  } else {
    next.minIndependentSources = Math.max(1, Number(next.minIndependentSources) || 1);
  }
  return next;
}

function sanitizePlannedGaps(gaps) {
  if (!Array.isArray(gaps)) return [];
  return gaps.map((gap) => ({
    ...gap,
    requiredHosts: sanitizeHosts(gap?.requiredHosts),
    preferredHosts: sanitizeHosts(gap?.preferredHosts),
    requiredSourceTypes: sanitizeSourceTypes(gap?.requiredSourceTypes),
  }));
}

export function mergeProfilePlan(base, plan = {}) {
  const next = {
    ...base,
    flags: { ...emptyFlags(), ...(base.flags || {}) },
    requiredHosts: unique([
      ...sanitizeHosts(base.requiredHosts),
      ...sanitizeHosts(plan.requiredHosts),
    ]),
    preferredHosts: unique([
      ...sanitizeHosts(base.preferredHosts),
      ...sanitizeHosts(plan.preferredHosts),
    ]),
    requiredSourceTypes: unique([
      ...sanitizeSourceTypes(base.requiredSourceTypes),
      ...sanitizeSourceTypes(plan.requiredSourceTypes),
    ]),
    minIndependentSources: Math.max(
      Number(base.minIndependentSources) || 1,
      Number(plan.minIndependentSources) || 0,
    ),
    plannedGaps: sanitizePlannedGaps(plan.gaps),
    evidenceScope: plan.evidenceScope || base.evidenceScope,
    method: plan.method ? `${base.method}+${plan.method}` : base.method,
  };
  for (const flag of PROFILE_FLAGS) {
    if (plan.flags && typeof plan.flags[flag] === 'boolean') next.flags[flag] = plan.flags[flag];
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

export async function planResearchProfile({ llm, query, profile, signal, settings, evidenceScope } = {}) {
  const scope = evidenceScope || profile?.evidenceScope || inferEvidenceScope(settings);
  const scoped = sanitizeEvidenceProfile(profile || inferResearchProfile(query, { settings, evidenceScope: scope }), {
    evidenceScope: scope,
    settings,
    query,
  });
  if (!llm?.complete) return scoped;
  try {
    const response = await llm.complete({
      purpose: 'research_profile',
      signal,
      temperature: 0,
      maxTokens: 500,
      messages: [{
        role: 'system',
        content: [
          'Infer a research evidence profile for THIS query only. Do not invent a fixed industry questionnaire.',
          'Return JSON only: {"flags":{"freshness":false,"completeness":false,"plurality":false,"attribution":false,"primary_source":false,"numeric":false,"decision_critical":false},"requiredHosts":[],"preferredHosts":[],"requiredSourceTypes":[],"minIndependentSources":1,"gaps":[{"question":"...","priority":"critical|normal","requiredHosts":[]}]}',
          'requiredHosts and preferredHosts must be real hostnames you decide this query needs. Leave them empty when unknown.',
          '"官方" / "official" means first-party documents of the subject, not stock-exchange or SEC filings unless the query names that venue.',
          'Do not default to hkexnews.hk, sec.gov, sse.com.cn, or szse.cn. Do not add primary_filing unless the query itself is about filings or disclosures.',
          'requiredSourceTypes may include primary_filing or numeric only.',
          scope === 'local'
            ? 'This run can only read local files. Do not invent web hosts such as fang.com, ke.com, or sec.gov. Leave requiredHosts empty unless the query literally names a hostname. Do not require primary_filing.'
            : '',
        ].filter(Boolean).join('\n'),
      }, {
        role: 'user',
        content: query,
      }],
    });
    const parsed = extractJson(response);
    if (!parsed) return scoped;
    return sanitizeEvidenceProfile(mergeProfilePlan(scoped, { ...parsed, method: 'llm' }), {
      evidenceScope: scope,
      settings,
      query,
    });
  } catch {
    return scoped;
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
    requiredSourceTypes: sanitizeSourceTypes(requiredSourceTypes ?? profile.requiredSourceTypes),
    requiredHosts: sanitizeHosts(requiredHosts ?? (priority === 'critical' ? profile.requiredHosts : [])),
    preferredHosts: sanitizeHosts(preferredHosts ?? profile.preferredHosts),
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
