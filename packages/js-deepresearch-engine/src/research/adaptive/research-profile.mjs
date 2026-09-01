import { classifyResearchQuery } from './exploratory-sufficiency.mjs';
import { inferEvidenceScope, listLocalCorpusChannels } from './source-policy.mjs';
import { mergeResearchBrief, sanitizeResearchBrief, slotsFromPlannerGaps } from '../research-brief.mjs';
import { GAP_SCHEMA_VERSION } from '../gap-state.mjs';
import { completeStructuredJson, hasUsablePlannerPayload } from '../structured-llm.mjs';

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
    brief: sanitizeResearchBrief(
      typeof query === 'object' ? query : { query: text },
      {
        query: text,
        depth: options.depth || 'exploratory',
        allowExplicitHosts: typeof query === 'object',
      },
    ),
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
    brief: sanitizeResearchBrief(profile.brief || { query: text }, {
      query: text,
      depth: profile.brief?.depth || 'exploratory',
      allowExplicitHosts: true,
    }),
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
    plannedGaps: sanitizePlannedGaps(plan.gaps ?? plan.plannedGaps),
    brief: mergeResearchBrief(base.brief || { query: base.query }, {
      ...(plan.brief || plan),
      requiredAnswerSlots: (plan.brief || plan).requiredAnswerSlots?.length
        ? (plan.brief || plan).requiredAnswerSlots
        : slotsFromPlannerGaps(plan.gaps ?? plan.plannedGaps, { query: base.query }),
    }, {
      query: base.query,
      depth: base.brief?.depth || 'exploratory',
    }),
    evidenceScope: plan.evidenceScope || base.evidenceScope,
    method: plan.method ? `${base.method}+${plan.method}` : base.method,
    contractUnavailable: Boolean(plan.contractUnavailable),
    contractFailure: plan.contractFailure || null,
    contractRetried: Boolean(plan.contractRetried),
  };
  for (const flag of PROFILE_FLAGS) {
    if (plan.flags && typeof plan.flags[flag] === 'boolean') next.flags[flag] = plan.flags[flag];
  }
  return next;
}

function profileSystemPrompt(scope, compact = false) {
  const local = scope === 'local'
    ? 'This run can only read local files. Do not invent web hosts such as fang.com, ke.com, or sec.gov. Leave requiredHosts empty unless the query literally names a hostname. Do not require primary_filing.'
    : '';
  if (compact) {
    return [
      'Return compact JSON only for THIS query. Do not invent a fixed industry questionnaire.',
      'Schema: {"requiredAnswerSlots":[{"answerSlot":"...","question":"...","priority":"critical|normal","evidenceCriteria":[]}],"requiredHosts":[],"requiredSourceTypes":[],"flags":{}}',
      'requiredAnswerSlots must be non-empty for this query. Do not omit the closing brace.',
      '"官方" / "official" means first-party documents of the subject, not stock-exchange or SEC filings unless the query names that venue.',
      'Do not default to hkexnews.hk, sec.gov, sse.com.cn, or szse.cn.',
      local,
    ].filter(Boolean).join('\n');
  }
  return [
    'Infer a research evidence profile for THIS query only. Do not invent a fixed industry questionnaire.',
    'Return JSON only: {"audience":null,"decision":null,"assumedExpertise":null,"timeRange":null,"geography":[],"entities":[],"exclusions":[],"successCriteria":[],"requiredAnswerSlots":[{"answerSlot":"...","question":"...","claimFamily":null,"priority":"critical|normal","evidenceCriteria":[]}],"consequentialClaims":[],"flags":{"freshness":false,"completeness":false,"plurality":false,"attribution":false,"primary_source":false,"numeric":false,"decision_critical":false},"requiredHosts":[],"preferredHosts":[],"requiredSourceTypes":[],"minIndependentSources":1,"gaps":[{"question":"...","priority":"critical|normal","requiredHosts":[]}]}',
    'requiredHosts and preferredHosts must be real hostnames you decide this query needs. Leave them empty when unknown.',
    '"官方" / "official" means first-party documents of the subject, not stock-exchange or SEC filings unless the query names that venue.',
    'Do not default to hkexnews.hk, sec.gov, sse.com.cn, or szse.cn. Do not add primary_filing unless the query itself is about filings or disclosures.',
    'requiredSourceTypes may include primary_filing or numeric only.',
    local,
  ].filter(Boolean).join('\n');
}

export function hasUsableResearchContract(profile = {}, brief = {}) {
  const resolved = brief.requiredAnswerSlots || profile.brief?.requiredAnswerSlots || [];
  return Boolean(
    resolved.length
    || (profile.requiredHosts || []).length
    || (profile.requiredSourceTypes || []).length
    || (profile.plannedGaps || []).length,
  );
}

export async function planResearchProfile({ llm, query, profile, signal, settings, evidenceScope } = {}) {
  const scope = evidenceScope || profile?.evidenceScope || inferEvidenceScope(settings);
  const scoped = sanitizeEvidenceProfile(profile || inferResearchProfile(query, { settings, evidenceScope: scope }), {
    evidenceScope: scope,
    settings,
    query,
  });
  if (!llm?.complete) {
    return sanitizeEvidenceProfile({
      ...scoped,
      method: scoped.method || 'rules',
      contractUnavailable: !hasUsableResearchContract(scoped, scoped.brief),
      contractFailure: hasUsableResearchContract(scoped, scoped.brief) ? null : 'no_llm',
    }, { evidenceScope: scope, settings, query });
  }
  try {
    const userSlots = scoped.brief?.requiredAnswerSlots || [];
    const acceptsSanitizedPlan = (parsed) => {
      if (!hasUsablePlannerPayload(parsed)) return false;
      if (userSlots.length) return true;
      const candidate = sanitizeEvidenceProfile(mergeProfilePlan(scoped, parsed), {
        evidenceScope: scope,
        settings,
        query,
      });
      return hasUsableResearchContract(candidate, candidate.brief);
    };
    const result = await completeStructuredJson({
      llm,
      signal,
      purpose: 'research_profile',
      maxTokens: 1200,
      retryMaxTokens: 800,
      accept: acceptsSanitizedPlan,
      messages: [{
        role: 'system',
        content: profileSystemPrompt(scope, false),
      }, {
        role: 'user',
        content: query,
      }],
      retryMessages: [{
        role: 'system',
        content: profileSystemPrompt(scope, true),
      }, {
        role: 'user',
        content: `Previous profile JSON was truncated or invalid. Return complete compact JSON for: ${query}`,
      }],
    });
    if (result.ok) {
      const merged = sanitizeEvidenceProfile(mergeProfilePlan(scoped, {
        ...result.parsed,
        method: result.retried ? 'llm+retry' : 'llm',
        contractRetried: result.retried,
      }), {
        evidenceScope: scope,
        settings,
        query,
      });
      merged.brief = {
        ...merged.brief,
        contractOrigin: userSlots.length ? 'user' : 'planner',
      };
      const usable = hasUsableResearchContract(merged, merged.brief);
      merged.contractUnavailable = !usable;
      merged.contractFailure = usable ? null : 'sanitized_empty_contract';
      merged.contractRetried = result.retried;
      return merged;
    }
    const unavailable = !userSlots.length && !hasUsableResearchContract(scoped, scoped.brief);
    return sanitizeEvidenceProfile({
      ...scoped,
      method: `${scoped.method}+degraded`,
      contractUnavailable: unavailable,
      contractFailure: result.reason || 'invalid_or_empty_json',
      contractRetried: result.retried,
    }, { evidenceScope: scope, settings, query });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const userSlots = scoped.brief?.requiredAnswerSlots || [];
    return sanitizeEvidenceProfile({
      ...scoped,
      method: `${scoped.method}+degraded`,
      contractUnavailable: !userSlots.length && !hasUsableResearchContract(scoped, scoped.brief),
      contractFailure: error?.message || 'planner_error',
    }, { evidenceScope: scope, settings, query });
  }
}

export function createRootGap(query, profile = {}) {
  return createGapRecord({
    id: 'gap-1',
    question: query,
    priority: 'critical',
    depth: 0,
    profile,
    kind: 'root',
    requiredSlot: false,
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
  answerSlot,
  claimFamily,
  requiredSlot,
  kind,
  rollup,
  evidenceCriteria,
} = {}) {
  return {
    schemaVersion: GAP_SCHEMA_VERSION,
    id,
    question: String(question || '').trim(),
    answerSlot: answerSlot || null,
    claimFamily: claimFamily || null,
    kind: kind || (requiredSlot ? 'slot' : 'followup'),
    rollup: Boolean(rollup),
    requiredSlot: Boolean(requiredSlot),
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
    supportingPassageIds: [],
    contradictingPassageIds: [],
    confidence: null,
    evidenceCriteria: Array.isArray(evidenceCriteria) ? evidenceCriteria.filter(Boolean) : [],
    slotSupport: null,
    missingEvidence: ['successful_body'],
    nextQueries: [],
    resolutionReason: null,
    blockedReason: null,
  };
}
