import { compactSearchSnippets, getSearchMeta } from '../search/search-result.mjs';

export function inferSearchOutcome({
  error = null,
  skipped = null,
  memoryStatus = null,
  resultCount = 0,
  siteRejectedCount = 0,
} = {}) {
  if (error) return 'failed';
  if (skipped === 'duplicate_query') return 'duplicate_query';
  if (memoryStatus === 'duplicate_results' || skipped === 'duplicate_results') return 'duplicate_results';
  if (Number(resultCount) <= 0 && Number(siteRejectedCount) > 0) return 'site_filtered_all';
  if (Number(resultCount) <= 0) return 'empty';
  return 'useful';
}

export function buildExecutedSearchTrace({
  query,
  queries = null,
  queryOrigin = null,
  plannerMode = null,
  plannedQueries = null,
  searchOptions = null,
  sources = [],
  searchMeta = null,
  resultCount = null,
  returnedResultCount = null,
  siteRejectedCount = 0,
  newUrlCount = 0,
  memoryStatus = null,
  error = null,
  skipped = null,
  targetGapIds = [],
  reasonCode = 'executed_search',
  siteFallbackOf = null,
} = {}) {
  const meta = searchMeta || getSearchMeta(sources) || {};
  const accepted = resultCount == null ? (sources?.length || 0) : resultCount;
  const returned = returnedResultCount == null ? (sources?.length || 0) : returnedResultCount;
  return {
    action: 'search',
    reasonCode,
    query,
    queries: queries || [query].filter(Boolean),
    queryOrigin,
    plannerMode,
    plannedQueries,
    searchOptions: searchOptions || meta.requestParams || null,
    requestParams: meta.requestParams || null,
    unresponsiveEngines: meta.unresponsiveEngines || [],
    respondedEngines: meta.respondedEngines || [],
    resultCount: accepted,
    returnedResultCount: returned,
    siteRejectedCount,
    newUrlCount,
    memoryStatus,
    outcome: inferSearchOutcome({
      error,
      skipped,
      memoryStatus,
      resultCount: accepted,
      siteRejectedCount,
    }),
    snippets: compactSearchSnippets(sources),
    targetGapIds: (targetGapIds || []).filter(Boolean),
    siteFallbackOf,
    error: error ? { name: error.name || 'Error', message: error.message || String(error) } : null,
  };
}
