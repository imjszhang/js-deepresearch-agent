import { classifyResearchQuery } from './exploratory-sufficiency.mjs';

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

export function inferEvidenceScope(settings = {}) {
  return String(settings?.search?.engine || '').trim().toLowerCase() === 'local'
    ? 'local'
    : 'web';
}

function filterHostsForScope(values, query, evidenceScope) {
  const hosts = sanitizeHosts(values);
  if (evidenceScope !== 'local') return hosts;
  const allowed = new Set(extractLiteralHosts(query));
  return hosts.filter((host) => allowed.has(host));
}

function filterSourceTypesForScope(values, evidenceScope) {
  const types = sanitizeSourceTypes(values);
  if (evidenceScope !== 'local') return types;
  return types.filter((type) => type !== 'primary_filing');
}

function minIndependentSourcesForScope(value, evidenceScope, fallback = 1) {
  const resolved = Number(value);
  const next = Number.isFinite(resolved) && resolved > 0 ? resolved : fallback;
  return evidenceScope === 'local' ? 1 : next;
}

function sanitizePlannedGaps(gaps, query, evidenceScope) {
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap) => {
    const originalHosts = sanitizeHosts(gap?.requiredHosts);
    const requiredHosts = filterHostsForScope(gap?.requiredHosts, query, evidenceScope);
    if (evidenceScope === 'local' && originalHosts.length && !requiredHosts.length) {
      return [];
    }
    return [{
      ...gap,
      requiredHosts,
      preferredHosts: filterHostsForScope(gap?.preferredHosts, query, evidenceScope),
      requiredSourceTypes: filterSourceTypesForScope(gap?.requiredSourceTypes, evidenceScope),
      minIndependentSources: minIndependentSourcesForScope(gap?.minIndependentSources, evidenceScope, 1),
    }];
  });
}

export function applyEvidenceScope(profile = {}, { query, settings, evidenceScope } = {}) {
  const text = String(query || profile.query || '');
  const scope = evidenceScope || profile.evidenceScope || inferEvidenceScope(settings);
  const next = {
    ...profile,
    query: profile.query || text,
    evidenceScope: scope,
  };
  if (scope !== 'local') return next;
  return {
    ...next,
    requiredHosts: filterHostsForScope(next.requiredHosts, text, scope),
    preferredHosts: filterHostsForScope(next.preferredHosts, text, scope),
    requiredSourceTypes: filterSourceTypesForScope(next.requiredSourceTypes, scope),
    minIndependentSources: 1,
    plannedGaps: sanitizePlannedGaps(next.plannedGaps, text, scope),
  };
}

export function inferResearchProfile(query = {}, settings) {
  const text = typeof query === 'string' ? query : String(query?.query || '');
  const resolvedSettings = settings ?? (typeof query === 'object' && query ? query.settings : undefined);
  const evidenceScope = inferEvidenceScope(resolvedSettings);
  const shape = classifyResearchQuery(text);
  return applyEvidenceScope({
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
  }, { query: text, evidenceScope });
}

export function mergeProfilePlan(base, plan = {}, options = {}) {
  const query = options.query || base.query || '';
  const evidenceScope = options.evidenceScope || base.evidenceScope || inferEvidenceScope(options.settings);
  const next = applyEvidenceScope({
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
    plannedGaps: sanitizePlannedGaps(plan.gaps, query, evidenceScope),
    method: plan.method ? `${base.method}+${plan.method}` : base.method,
    evidenceScope,
  }, { query, evidenceScope });
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

export async function planResearchProfile({ llm, query, profile, signal, settings } = {}) {
  const evidenceScope = profile?.evidenceScope || inferEvidenceScope(settings);
  const scoped = applyEvidenceScope(profile, { query, settings, evidenceScope });
  if (!llm?.complete) return scoped;
  try {
    const localOnly = evidenceScope === 'local';
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
          localOnly
            ? 'This run searches local directories only. Do not require public-web hosts, exchange filings, or site: queries. Leave requiredHosts, preferredHosts, and requiredSourceTypes empty unless the query itself names a hostname. Do not remap local folders to official hosts.'
            : '',
        ].filter(Boolean).join('\n'),
      }, {
        role: 'user',
        content: query,
      }],
    });
    const parsed = extractJson(response);
    if (!parsed) return scoped;
    return mergeProfilePlan(scoped, { ...parsed, method: 'llm' }, { query, evidenceScope, settings });
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
    requiredSourceTypes: filterSourceTypesForScope(
      requiredSourceTypes ?? profile.requiredSourceTypes,
      profile.evidenceScope,
    ),
    requiredHosts: filterHostsForScope(
      requiredHosts ?? (priority === 'critical' ? profile.requiredHosts : []),
      profile.query || question,
      profile.evidenceScope,
    ),
    preferredHosts: filterHostsForScope(
      preferredHosts ?? profile.preferredHosts,
      profile.query || question,
      profile.evidenceScope,
    ),
    blockedHosts: [],
    maxAgeDays: maxAgeDays ?? profile.maxAgeDays ?? null,
    minIndependentSources: minIndependentSourcesForScope(
      minIndependentSources ?? profile.minIndependentSources,
      profile.evidenceScope,
    ),
    searchedQueries: [],
    candidateUrls: [],
    readSourceIds: [],
    evidencePassageIds: [],
    blockedReason: null,
  };
}
