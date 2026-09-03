const DEFAULT_LIMIT = 12;

function asRejected(item, fallbackReason = 'rejected') {
  if (!item) return null;
  if (typeof item === 'string') {
    const query = item.trim();
    return query ? { query, reason: fallbackReason } : null;
  }
  const query = String(item.query || '').trim();
  if (!query) return null;
  return {
    query,
    reason: item.reason || fallbackReason,
    duplicateOf: item.duplicateOf || null,
    step: item.step ?? null,
    outcome: item.outcome || null,
  };
}

function compactOutcome(item = {}) {
  if (!item?.query) return null;
  return {
    query: item.query,
    outcome: item.outcome || null,
    gapId: item.gapId || null,
    queryOrigin: item.queryOrigin || null,
    plannerMode: item.plannerMode || null,
    resultCount: item.resultCount ?? null,
    returnedResultCount: item.returnedResultCount ?? null,
    siteRejectedCount: item.siteRejectedCount ?? null,
    newUrlCount: item.newUrlCount ?? null,
    memoryStatus: item.memoryStatus || null,
    searchOptions: item.searchOptions || null,
    respondedEngines: item.respondedEngines || [],
    unresponsiveEngines: item.unresponsiveEngines || [],
    snippets: Array.isArray(item.snippets) ? item.snippets.slice(0, 3) : [],
  };
}

export function buildPlannerFeedback({
  searchedQueries = [],
  exhaustedAngles = [],
  rejectedQueries = [],
  filteredQueries = [],
  plannerRejections = [],
  recentSearchOutcomes = [],
  queryMemoryEntries = [],
  providerCapabilities = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const rejected = [
    ...(rejectedQueries || []).map((item) => asRejected(item)),
    ...(plannerRejections || []).map((item) => asRejected(item)),
    ...(filteredQueries || []).map((item) => asRejected(item, item.reason || 'filtered')),
    ...(queryMemoryEntries || [])
      .filter((entry) => ['empty', 'duplicate_results', 'failed'].includes(entry.status))
      .map((entry) => asRejected({
        query: entry.query,
        reason: entry.status,
        outcome: entry.status,
      })),
  ].filter(Boolean);
  const seenRejected = new Set();
  const uniqueRejected = [];
  for (const item of rejected) {
    const key = `${item.query}\0${item.reason || ''}`;
    if (seenRejected.has(key)) continue;
    seenRejected.add(key);
    uniqueRejected.push(item);
  }
  const outcomes = (recentSearchOutcomes || []).map(compactOutcome).filter(Boolean);
  return {
    searchedQueries: uniqueStrings(searchedQueries).slice(-Math.max(limit, 1)),
    exhaustedAngles: uniqueStrings(exhaustedAngles).slice(-Math.max(limit, 1)),
    rejectedQueries: uniqueRejected.slice(-Math.max(limit, 1)),
    recentSearchOutcomes: outcomes.slice(-Math.max(limit, 1)),
    providerCapabilities: providerCapabilities || null,
  };
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function plannerFeedbackFromState(state, extra = {}) {
  const scoped = extra.gap !== undefined;
  const gap = scoped ? extra.gap : null;
  const gapOutcomes = (state?.searchOutcomes || []).filter((item) => !gap || item.gapId === gap.id);
  return buildPlannerFeedback({
    searchedQueries: extra.searchedQueries
      || (gap ? (gap.searchedQueries || []) : (state?.searchedQueries?.() || [])),
    exhaustedAngles: extra.exhaustedAngles || (gap
      ? (gap.exhaustedAngles || [])
      : [
        ...(state?.gaps || []).flatMap((item) => item.exhaustedAngles || []),
      ]),
    rejectedQueries: extra.rejectedQueries || [],
    filteredQueries: extra.filteredQueries || (gap
      ? (gap.filteredQueries || [])
      : [
        ...(state?.gaps || []).flatMap((item) => item.filteredQueries || []),
      ]),
    plannerRejections: extra.plannerRejections || state?.plannerRejections || [],
    recentSearchOutcomes: extra.recentSearchOutcomes
      || (gap ? gapOutcomes : (state?.recentSearchOutcomes?.() || [])),
    queryMemoryEntries: extra.queryMemory?.entries || extra.queryMemoryEntries || [],
    providerCapabilities: extra.providerCapabilities || extra.search?.capabilities || null,
  });
}
