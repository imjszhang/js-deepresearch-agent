import { completeStructuredJson } from './structured-llm.mjs';
import { searchQueryPlannerPrompt, searchQueryPlannerRetryPrompt } from './prompts.mjs';
import { normalizeQuery, querySimilarity } from './query-memory.mjs';
import { queryMatchesGapScope, siteHostsFromQuery } from './adaptive/source-policy.mjs';
import { sanitizeSearchOptions } from '../search/normalize-search-config.mjs';

export const SEARCH_QUERY_MODES = Object.freeze([
  'initial',
  'repair',
  'challenge',
  'angle_change',
  'recovery',
  'site_fallback',
]);

export const QUERY_ORIGINS = Object.freeze({
  userQuery: 'user_query',
  llmPlanner: 'llm_planner',
});

export const SEARCH_QUERY_PLANNER_PURPOSE = 'search_query_planning';

const FORBIDDEN_TEMPLATES = [
  'primary source evidence',
  'conflicting evidence correction',
  'counterexample failure',
  'different definition date denominator',
  'alternative explanation',
];

const INTERNAL_SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;

export function createPlannedQuery({
  query,
  origin = QUERY_ORIGINS.llmPlanner,
  plannerMode = null,
  plannerPurpose = SEARCH_QUERY_PLANNER_PURPOSE,
  targetGapId = null,
  parentQueryId = null,
  siteFallbackOf = null,
  intent = null,
  expectedEvidence = null,
  sourceType = null,
  searchOptions = null,
} = {}) {
  return {
    query: String(query || '').trim(),
    queryOrigin: origin,
    plannerMode,
    plannerPurpose,
    targetGapId: targetGapId || null,
    parentQueryId: parentQueryId || null,
    siteFallbackOf: siteFallbackOf || null,
    intent: intent || null,
    expectedEvidence: expectedEvidence || null,
    sourceType: sourceType || null,
    searchOptions: sanitizeSearchOptions(searchOptions),
  };
}

export function allowedSiteHosts({
  gap = {},
  siteQueryMode = 'confirmed',
  observedHosts = [],
  evidenceScope = 'web',
} = {}) {
  if (evidenceScope === 'local' || siteQueryMode === 'never') return [];
  const required = unique((gap.requiredHosts || []).map(normalizeHost));
  const preferred = unique((gap.preferredHosts || []).map(normalizeHost));
  const observed = unique((observedHosts || []).map(normalizeHost));
  if (siteQueryMode === 'always') return unique([...required, ...preferred]);
  return unique([
    ...required,
    ...preferred.filter((host) => observed.some((item) => hostsMatch(item, host))),
  ]);
}

export function validatePlannedQuery(query, {
  gap = {},
  entities = [],
  comparedQueries = [],
  similarityThreshold = 0.86,
  siteQueryMode = 'confirmed',
  observedHosts = [],
  evidenceScope = 'web',
  mode = 'initial',
  scopeTexts = [],
} = {}) {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty_query' };
  if (text.length < 2) return { ok: false, reason: 'empty_query' };
  const lower = text.toLowerCase();
  if (FORBIDDEN_TEMPLATES.some((item) => lower.includes(item))) {
    return { ok: false, reason: 'forbidden_template' };
  }
  const identifiers = internalIdentifiers(gap);
  if (identifiers.some((item) => containsIdentifier(text, item)) || leaksSnakeCase(text, identifiers)) {
    return { ok: false, reason: 'internal_identifier' };
  }
  const hosts = siteHostsFromQuery(text);
  if (evidenceScope === 'local' && hosts.length) {
    return { ok: false, reason: 'local_site_forbidden' };
  }
  if (mode === 'site_fallback' && hosts.length) {
    return { ok: false, reason: 'site_mode_violation' };
  }
  if (hosts.length) {
    const allowed = allowedSiteHosts({ gap, siteQueryMode, observedHosts, evidenceScope });
    if (!allowed.length || hosts.some((host) => !allowed.some((item) => hostsMatch(host, item)))) {
      return { ok: false, reason: 'site_mode_violation' };
    }
  }
  if (gap && Object.keys(gap).length && !queryMatchesGapScope(text, gap, entities, scopeTexts)) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  const duplicate = (comparedQueries || []).find((seen) => (
    normalizeQuery(seen) === normalizeQuery(text)
    || querySimilarity(seen, text) >= similarityThreshold
  ));
  if (duplicate) {
    return { ok: false, reason: 'all_duplicates', duplicateOf: duplicate };
  }
  return { ok: true, query: text };
}

export async function planSearchQueries({
  llm,
  signal,
  mode = 'initial',
  query = '',
  gap = null,
  gaps = [],
  brief = {},
  readiness = null,
  limit = 3,
  siteQueryMode = 'confirmed',
  evidenceScope = 'web',
  searchedQueries = [],
  rejectedQueries = [],
  exhaustedAngles = [],
  observedHosts = [],
  siteFallbackFor = '',
  queryMemory = null,
  gapId = null,
  context = '',
  hints = [],
  recentSearchOutcomes = [],
  providerCapabilities = null,
} = {}) {
  const resolvedMode = SEARCH_QUERY_MODES.includes(mode) ? mode : 'initial';
  const resolvedLimit = Number(limit);
  const targetGap = gap || (gapId ? (gaps || []).find((item) => item.id === gapId) : null) || null;
  if (!Number.isFinite(resolvedLimit) || resolvedLimit <= 0) {
    return buildPlanResult({
      ok: false,
      mode: resolvedMode,
      gapId: targetGap?.id || gapId || null,
      planned: [],
      rejected: [],
      attempts: 0,
      retried: false,
      failure: 'empty_limit',
      metadata: null,
    });
  }
  const compared = unique([
    ...(searchedQueries || []),
    ...(exhaustedAngles || []),
    ...(targetGap?.searchedQueries || []),
    ...(targetGap?.exhaustedAngles || []),
    ...(rejectedQueries || []).map((item) => item.query || item),
  ]);
  const validationOptions = {
    gap: targetGap || {},
    entities: brief?.entities || [],
    comparedQueries: compared,
    siteQueryMode,
    observedHosts,
    evidenceScope,
    mode: resolvedMode,
    scopeTexts: [query, brief?.query],
  };
  const allowedHosts = allowedSiteHosts({
    gap: targetGap || {},
    siteQueryMode,
    observedHosts,
    evidenceScope,
  });
  const accept = (parsed) => extractQueryItems(parsed).some((item) => (
    validatePlannedQuery(item.query, validationOptions).ok
  ));
  const promptArgs = {
    mode: resolvedMode,
    query,
    gap: compactGap(targetGap),
    gaps: (gaps || []).map(compactGap),
    brief: compactBrief(brief),
    readiness,
    limit: resolvedLimit,
    searchedQueries: compared,
    rejectedQueries,
    exhaustedAngles: unique([...(exhaustedAngles || []), ...(targetGap?.exhaustedAngles || [])]),
    observedHosts,
    allowedSiteHosts: allowedHosts,
    evidenceScope,
    siteQueryMode,
    siteFallbackFor,
    context,
    hints,
    recentSearchOutcomes,
    providerCapabilities,
  };

  const result = await completeStructuredJson({
    llm,
    signal,
    purpose: SEARCH_QUERY_PLANNER_PURPOSE,
    maxTokens: resolvedMode === 'initial' ? 600 : 400,
    retryMaxTokens: 500,
    accept,
    messages: searchQueryPlannerPrompt(promptArgs),
    retryMessages: searchQueryPlannerRetryPrompt(promptArgs),
  });

  const rawItems = extractQueryItems(result.parsed);
  const firstPass = finalizeQueries(rawItems, {
    ...validationOptions,
    limit: resolvedLimit,
    queryMemory,
    gapId: targetGap?.id || gapId,
    mode: resolvedMode,
    siteFallbackFor,
  });
  if (firstPass.accepted.length) {
    return buildPlanResult({
      ok: true,
      mode: resolvedMode,
      gapId: targetGap?.id || gapId || null,
      planned: firstPass.accepted,
      rejected: firstPass.rejected,
      attempts: result.attempts,
      retried: result.retried,
      failure: null,
      metadata: result.metadata,
    });
  }

  if (!result.ok && result.reason === 'no_llm') {
    return buildPlanResult({
      ok: false,
      mode: resolvedMode,
      gapId: targetGap?.id || gapId || null,
      planned: [],
      rejected: firstPass.rejected,
      attempts: result.attempts,
      retried: result.retried,
      failure: 'no_llm',
      metadata: result.metadata,
    });
  }

  const retryArgs = {
    ...promptArgs,
    rejectedQueries: [
      ...rejectedQueries,
      ...firstPass.rejected,
    ],
    rejectionReasons: firstPass.rejected.map((item) => item.reason),
  };
  const retry = await completeStructuredJson({
    llm,
    signal,
    purpose: SEARCH_QUERY_PLANNER_PURPOSE,
    maxTokens: 400,
    retryMaxTokens: 400,
    accept,
    messages: searchQueryPlannerRetryPrompt(retryArgs),
  });
  const retryItems = extractQueryItems(retry.parsed);
  const secondPass = finalizeQueries(retryItems, {
    ...validationOptions,
    limit: resolvedLimit,
    queryMemory,
    gapId: targetGap?.id || gapId,
    mode: resolvedMode,
    siteFallbackFor,
  });
  if (secondPass.accepted.length) {
    return buildPlanResult({
      ok: true,
      mode: resolvedMode,
      gapId: targetGap?.id || gapId || null,
      planned: secondPass.accepted,
      rejected: [...firstPass.rejected, ...secondPass.rejected],
      attempts: (result.attempts || 0) + (retry.attempts || 0),
      retried: true,
      failure: null,
      metadata: retry.metadata || result.metadata,
    });
  }

  return buildPlanResult({
    ok: false,
    mode: resolvedMode,
    gapId: targetGap?.id || gapId || null,
    planned: [],
    rejected: [...firstPass.rejected, ...secondPass.rejected],
    attempts: (result.attempts || 0) + (retry.attempts || 0),
    retried: true,
    failure: failureFrom(result, retry, [...firstPass.rejected, ...secondPass.rejected]),
    metadata: retry.metadata || result.metadata,
  });
}

function unusedOriginalUserQuery(planArgs = {}) {
  const original = String(planArgs.query || '').trim();
  if (!original) return '';
  const searched = [
    ...(planArgs.searchedQueries || []),
    ...(planArgs.exhaustedAngles || []),
    ...(planArgs.gap?.searchedQueries || []),
    ...(planArgs.gap?.exhaustedAngles || []),
  ].map(normalizeQuery);
  if (searched.includes(normalizeQuery(original))) return '';
  return original;
}

function unusedUserQuery(action, planArgs = {}) {
  const original = unusedOriginalUserQuery(planArgs);
  const candidate = String(action?.query || (action?.queries || [])[0] || '').trim();
  if (!original || !candidate) return '';
  if (normalizeQuery(candidate) !== normalizeQuery(original)) return '';
  return original;
}

export async function attachPlannedQueries(action, planArgs = {}) {
  if (action?.action !== 'search') return { action, plan: null };
  const userQuery = unusedUserQuery(action, planArgs);
  if ((action.queryOrigin === QUERY_ORIGINS.userQuery && String(action.query || '').trim()) || userQuery) {
    const query = userQuery || String(action.query).trim();
    return {
      action: {
        ...action,
        query,
        queries: unique([query, ...(action.queries || [])]),
        queryOrigin: QUERY_ORIGINS.userQuery,
        needsPlanner: false,
        plannedQueries: [createPlannedQuery({
          query,
          origin: QUERY_ORIGINS.userQuery,
          plannerMode: null,
          targetGapId: action.gapId || null,
        })],
      },
      plan: null,
    };
  }
  const plan = await planSearchQueries({
    ...planArgs,
    mode: action.plannerMode || planArgs.mode || 'recovery',
    gapId: action.gapId || planArgs.gapId,
    siteFallbackFor: action.siteFallbackOf || planArgs.siteFallbackFor,
    hints: unique([
      ...(planArgs.hints || []),
      action.query,
      ...(action.queries || []),
    ]),
  });
  if (!plan.ok) {
    const fallback = unusedOriginalUserQuery(planArgs);
    if (fallback) {
      return {
        action: {
          ...action,
          query: fallback,
          queries: [fallback],
          queryOrigin: QUERY_ORIGINS.userQuery,
          needsPlanner: false,
          planFailure: plan.failure,
          plannedQueries: [createPlannedQuery({
            query: fallback,
            origin: QUERY_ORIGINS.userQuery,
            plannerMode: null,
            targetGapId: action.gapId || planArgs.gapId || null,
          })],
        },
        plan,
      };
    }
    return {
      action: {
        ...action,
        query: '',
        queries: [],
        planFailure: plan.failure,
      },
      plan,
    };
  }
  return {
    action: {
      ...action,
      query: plan.queries[0],
      queries: plan.queries,
      queryOrigin: QUERY_ORIGINS.llmPlanner,
      plannerMode: plan.mode,
      plannedQueries: plan.planned,
    },
    plan,
  };
}

function finalizeQueries(items, {
  limit,
  queryMemory,
  gapId,
  mode,
  siteFallbackFor,
  ...validationOptions
}) {
  const rejected = [];
  const accepted = [];
  const seen = new Set();
  for (const item of items) {
    const validation = validatePlannedQuery(item.query, {
      ...validationOptions,
      comparedQueries: [
        ...(validationOptions.comparedQueries || []),
        ...accepted.map((entry) => entry.query),
      ],
    });
    if (!validation.ok) {
      rejected.push({
        query: String(item.query || '').trim(),
        reason: validation.reason,
        duplicateOf: validation.duplicateOf || null,
      });
      continue;
    }
    const normalized = normalizeQuery(validation.query);
    if (seen.has(normalized)) {
      rejected.push({ query: validation.query, reason: 'all_duplicates' });
      continue;
    }
    seen.add(normalized);
    accepted.push(createPlannedQuery({
      query: validation.query,
      origin: QUERY_ORIGINS.llmPlanner,
      plannerMode: mode,
      targetGapId: item.targetGapId || gapId || null,
      siteFallbackOf: mode === 'site_fallback' ? siteFallbackFor || null : null,
      intent: item.intent,
      expectedEvidence: item.expectedEvidence,
      sourceType: item.sourceType,
      searchOptions: item.searchOptions,
    }));
    if (accepted.length >= limit) break;
  }
  if (queryMemory?.enabled && accepted.length) {
    const memoryRejected = [];
    const kept = [];
    for (const item of accepted) {
      const exact = (queryMemory.entries || []).find((entry) => (
        entry.status !== 'cancelled' && normalizeQuery(entry.query) === normalizeQuery(item.query)
      ));
      if (exact) {
        memoryRejected.push({ query: item.query, reason: 'all_duplicates', duplicateOf: exact.query });
      } else {
        kept.push(item);
      }
    }
    return { accepted: kept, rejected: [...rejected, ...memoryRejected] };
  }
  return { accepted, rejected };
}

function buildPlanResult({
  ok,
  mode,
  gapId,
  planned,
  rejected,
  attempts,
  retried,
  failure,
  metadata,
}) {
  return {
    ok,
    queries: planned.map((item) => item.query),
    planned,
    mode,
    gapId,
    reasonCode: `search_query_${mode}`,
    attempts: attempts || 0,
    retried: Boolean(retried),
    failure,
    dedup: {
      accepted: planned.map((item) => item.query),
      rejected,
    },
    metadata: metadata || null,
  };
}

function failureFrom(first, second, rejected = []) {
  if (first?.reason === 'no_llm') return 'no_llm';
  const reasons = rejected.map((item) => item.reason).filter(Boolean);
  if (reasons.includes('local_site_forbidden')) return 'local_site_forbidden';
  if (reasons.includes('site_mode_violation')) return 'site_mode_violation';
  if (reasons.includes('scope_mismatch')) return 'scope_mismatch';
  if (reasons.includes('internal_identifier')) return 'internal_identifier';
  if (reasons.includes('forbidden_template')) return 'forbidden_template';
  if (reasons.length && reasons.every((reason) => reason === 'all_duplicates')) return 'all_duplicates';
  return second?.reason || first?.reason || 'invalid_or_empty_json';
}

function extractQueryItems(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.map(asQueryItem).filter((item) => item.query);
  const queries = parsed.queries;
  if (Array.isArray(queries)) return queries.map(asQueryItem).filter((item) => item.query);
  if (parsed.query) return [asQueryItem(parsed)].filter((item) => item.query);
  return [];
}

function asQueryItem(value) {
  if (typeof value === 'string') return { query: value.trim() };
  if (!value || typeof value !== 'object') return { query: '' };
  return {
    query: String(value.query || '').trim(),
    targetGapId: value.targetGapId || null,
    intent: value.intent || null,
    expectedEvidence: value.expectedEvidence || null,
    sourceType: value.sourceType || null,
    searchOptions: sanitizeSearchOptions(value.searchOptions),
  };
}

function compactGap(gap) {
  if (!gap) return null;
  return {
    id: gap.id || null,
    question: gap.question || '',
    missingEvidence: gap.missingEvidence || [],
    requiredHosts: gap.requiredHosts || [],
    preferredHosts: gap.preferredHosts || [],
    requiredSourceTypes: gap.requiredSourceTypes || [],
    priority: gap.priority || null,
    status: gap.status || null,
    evidenceIntent: (gap.evidenceCriteria || []).map((item) => String(item).replace(/[_-]+/g, ' ')),
  };
}

function compactBrief(brief = {}) {
  return {
    query: brief.query || '',
    entities: brief.entities || [],
    exclusions: brief.exclusions || [],
    geography: brief.geography || [],
    timeRange: brief.timeRange || null,
    asOf: brief.asOf || null,
    entityAliases: brief.entityAliases || [],
    slots: (brief.requiredAnswerSlots || []).map((slot) => ({
      id: slot.id,
      question: slot.question,
      priority: slot.priority,
    })),
  };
}

function internalIdentifiers(gap = {}) {
  return unique([
    gap.answerSlot,
    gap.claimFamily,
    ...(gap.evidenceCriteria || []),
    ...(gap.successCriteria || []),
  ].filter((item) => /_/.test(String(item || ''))));
}

function containsIdentifier(query, identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return false;
  const lower = query.toLowerCase();
  if (lower.includes(raw.toLowerCase())) return true;
  const spaced = raw.replace(/[_-]+/g, ' ').toLowerCase();
  return Boolean(spaced) && lower.includes(spaced);
}

function leaksSnakeCase(query, identifiers) {
  if (!INTERNAL_SNAKE.test(query)) return false;
  return identifiers.some((item) => query.includes(item));
}

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/^www\./, '').trim();
}

function hostsMatch(left, right) {
  const a = normalizeHost(left);
  const b = normalizeHost(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}
