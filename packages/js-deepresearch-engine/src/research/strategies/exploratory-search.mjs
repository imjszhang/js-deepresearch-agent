import { pickUnreadCandidates } from '../adaptive/agent-policy.mjs';
import { siteHostsFromQuery, sourceMatchesSiteQuery } from '../adaptive/source-policy.mjs';
import { markRepairAngleExhausted } from '../adaptive/slot-repair-scheduler.mjs';
import { planSearchQueries } from '../search-query-planner.mjs';
import { buildExecutedSearchTrace } from '../search-trace.mjs';
import { filterSearchOptions } from '../../search/search-capabilities.mjs';
import { createHash } from 'node:crypto';
import { getSearchMeta, attachSearchMeta } from '../../search/search-result.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveSearchConcurrency } from '../../search/search-capabilities.mjs';
import { isTransientSearchError } from '../../search/search-provider-error.mjs';
import { normalizeQuery } from '../query-memory.mjs';
import { clusterUrlRecords } from '../adaptive/embedding-signals.mjs';
import { abort, addTrace, addSerpKnowledge, plannerContext, recordPlannerMetrics, observeRerank } from './exploratory-planning.mjs';

export function createSearchExecutor({ state, search, settings, budget, emit, signal, queryMemory, llm, readPolicy, embedding, researchProviders, trace, maxQueriesPerStep, autoReadTopK, performRead }) {
  const rawSearch = search;
  const provider = settings.search?.engine || rawSearch.id || rawSearch.provider || 'search';
  const effectiveOptions = (searchOptions) => ({
    maxResults: settings.search?.maxResults || null,
    providerConfigHash: createHash('sha256').update(JSON.stringify(settings.search?.provider || {})).digest('hex'),
    options: filterSearchOptions({ ...(settings.search?.options || {}), ...(settings.search?.language ? { language: settings.search.language } : {}), ...(searchOptions || {}) }, rawSearch.capabilities).effective,
  });
  const canReuse = (query, searchOptions) => Boolean(state.evidenceStore && queryMemory?.getExecuted(query, provider, effectiveOptions(searchOptions)));
  if (state.evidenceStore && queryMemory) search = { ...rawSearch, async search(query, options) {
    const effective = effectiveOptions(options?.searchOptions);
    const cached = queryMemory.getExecuted(query, provider, effective);
    if (cached) {
      addTrace(trace, state, 'search_cache_hit', { query, provider, resultCount: cached.results.length }, budget);
      return attachSearchMeta(globalThis.structuredClone(cached.results), cached.searchMeta || {});
    }
    const results = await rawSearch.search(query, options);
    queryMemory.recordExecuted(query, provider, effective, results);
    return results;
  } };
  const performSearch = async function performSearch(action, searchQueries, gate) {
    const gapId = action.gapId || state.focusGap()?.id || 'gap-1';
    const gap = state.getGap(gapId);
    state.forbidFinalizeUntilExplore = false;
    state.beginSearchCycle();
    const allowedQueries = [];
    for (const searchQuery of searchQueries) {
      if (allowedQueries.length === 0 || !budget || budget.canClaim('searchRequests', allowedQueries.length + 1)) {
        allowedQueries.push(searchQuery);
      }
    }
    emit({
      stage: 'searching',
      step: state.step,
      maxSteps: state.maxSteps,
      total: allowedQueries.length,
    });
    const candidatesBefore = state.candidates.size;
    const plannedByQuery = new Map((action.plannedQueries || []).map((item) => [item.query, item]));
    const concurrency = resolveSearchConcurrency(search, settings, 1);
    const executed = await searchQuestions({
      questions: allowedQueries.map((searchQuery) => ({
        question: searchQuery,
        searchOptions: plannedByQuery.get(searchQuery)?.searchOptions || null,
      })),
      search,
      signal,
      concurrency,
      gapId,
    });
    const searchResults = executed.map((item) => {
      const planned = plannedByQuery.get(item.searchQuery || item.question);
      return {
        searchQuery: item.searchQuery || item.question,
        results: item.sources || [],
        searchMeta: item.searchMeta,
        planned,
        searchOptions: item.searchOptions,
        queryOrigin: planned?.queryOrigin || action.queryOrigin || 'llm_planner',
        plannerMode: planned?.plannerMode || action.plannerMode || null,
        error: item.error || null,
        skipped: item.skipped || null,
      };
    });
    const fallbackQueries = new Set();
    for (const { searchQuery, results } of [...searchResults]) {
      state.observeHosts(results);
      const acceptedResults = readPolicy.relevance.siteConstraint
        ? results.filter((result) => sourceMatchesSiteQuery(result, searchQuery))
        : results;
      const rejectedForSite = results.length - acceptedResults.length;
      if (
        acceptedResults.length === 0
        && rejectedForSite > 0
        && siteHostsFromQuery(searchQuery).length > 0
        && searchResults.length < maxQueriesPerStep
        && (!budget || budget.canClaim('searchRequests'))
      ) {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        const fallbackPlan = await planSearchQueries({
          ...plannerContext(state, {
            llm,
            signal,
            queryMemory,
            gate,
            search,
            gap,
            rejectedQueries: [{ query: searchQuery, reason: 'site_filtered_all' }],
            siteFallbackFor: searchQuery,
          }),
          mode: 'site_fallback',
          gap,
          gapId,
          limit: 1,
        });
        state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
        recordPlannerMetrics(state, fallbackPlan);
        const siteFree = fallbackPlan.queries[0] || '';
        const normalizedFallback = normalizeQuery(siteFree);
        const exactSeen = new Set([
          ...searchResults.map((item) => item.searchQuery),
          ...state.searchedQueries(),
          ...(gap.exhaustedAngles || []),
        ].map(normalizeQuery));
        if (fallbackPlan.ok && normalizedFallback && !exactSeen.has(normalizedFallback)) {
          abort(signal);
          const fallbackOptions = fallbackPlan.planned?.[0]?.searchOptions || null;
          try {
            const fallbackResults = await search.search(siteFree, { signal, searchOptions: fallbackOptions });
            searchResults.push({
              searchQuery: siteFree,
              results: Array.isArray(fallbackResults) ? fallbackResults : [],
              searchMeta: getSearchMeta(fallbackResults),
              planned: fallbackPlan.planned?.[0] || null,
              searchOptions: fallbackOptions,
              queryOrigin: 'llm_planner',
              plannerMode: 'site_fallback',
              siteFallbackOf: searchQuery,
              error: null,
            });
            state.observeHosts(fallbackResults);
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            searchResults.push({
              searchQuery: siteFree,
              results: [],
              searchMeta: null,
              planned: fallbackPlan.planned?.[0] || null,
              searchOptions: fallbackOptions,
              queryOrigin: 'llm_planner',
              plannerMode: 'site_fallback',
              siteFallbackOf: searchQuery,
              error,
            });
          }
          fallbackQueries.add(siteFree);
          state.recovery.siteFallbackQueries += 1;
          addTrace(trace, state, 'search', {
            reasonCode: 'site_fallback_query',
            query: siteFree,
            fallbackFor: searchQuery,
            siteFallbackOf: searchQuery,
            queryOrigin: 'llm_planner',
            plannerMode: 'site_fallback',
            plannedQueries: fallbackPlan.planned || null,
            searchOptions: fallbackOptions,
            targetGapIds: [gapId],
          }, budget);
        }
      }
    }
    let totalResults = 0;
    let returnedResults = 0;
    let siteRejectedResults = 0;
    let newUrls = 0;
    let duplicateSerp = false;
    let successfulAutoReads = 0;
    for (const item of searchResults) {
      const { searchQuery, results, searchMeta, searchOptions, planned, error } = item;
      returnedResults += results.length;
      const acceptedResults = readPolicy.relevance.siteConstraint
        ? results.filter((result) => sourceMatchesSiteQuery(result, searchQuery))
        : results;
      const rejectedForSite = results.length - acceptedResults.length;
      state.relevance.returnedCandidates += results.length;
      state.relevance.siteRejected += rejectedForSite;
      state.relevance.admittedCandidates += acceptedResults.length;
      totalResults += acceptedResults.length;
      siteRejectedResults += rejectedForSite;
      if (rejectedForSite > 0) {
        addTrace(trace, state, 'search_filter', {
          reasonCode: 'site_constraint_violation',
          query: searchQuery,
          targetGapIds: [gapId],
          rejectedCount: rejectedForSite,
          acceptedCount: acceptedResults.length,
        }, budget, 'filtered');
      }
      const memoryEntry = isTransientSearchError(error)
        ? null
        : queryMemory?.record?.({
          query: searchQuery,
          gapId,
          status: acceptedResults.length ? 'useful' : 'empty',
          results: acceptedResults,
        });
      if (memoryEntry?.status === 'duplicate_results') {
        duplicateSerp = true;
        state.addDiary(`duplicate results for "${searchQuery}"; skip equivalent searches`);
      }
      if (acceptedResults.length > 0) {
        state.recordSearchedQuery(gapId, searchQuery);
      } else if (isTransientSearchError(error)) {
        state.recordTransientSearch(error);
      } else {
        const reason = error ? 'failed' : (rejectedForSite > 0 ? 'site_filtered_all' : 'empty_results');
        state.recordFilteredQuery(gapId, searchQuery, reason);
      }
      const clustered = await clusterUrlRecords(acceptedResults.map((result) => ({
        ...result,
        hostname: result.hostname,
        registrableDomain: result.registrableDomain,
      })), { embedding, signal, traces: state.embeddingTraces });
      const clusterById = Object.fromEntries(clustered.map((item) => [item.id || item.url, item.clusterId]));
      const addedThisQuery = state.addCandidates(clustered, gapId, { query: searchQuery, clusterById });
      newUrls += addedThisQuery;
      state.noteSearchYield({
        duplicateResults: memoryEntry?.status === 'duplicate_results',
        newUrls: addedThisQuery,
      });
      addSerpKnowledge(state, acceptedResults, gapId);
      const outcome = state.recordSearchOutcome({
        query: searchQuery,
        queryOrigin: item.queryOrigin || action.queryOrigin || 'llm_planner',
        plannerMode: item.plannerMode || action.plannerMode || null,
        gapId,
        searchOptions,
        searchMeta,
        sources: acceptedResults,
        resultCount: acceptedResults.length,
        returnedResultCount: results.length,
        siteRejectedCount: rejectedForSite,
        newUrlCount: addedThisQuery,
        memoryStatus: memoryEntry?.status || null,
        error,
        skipped: memoryEntry?.status === 'duplicate_results' ? 'duplicate_results' : null,
      });
      state.observations.push({
        type: 'search_result',
        query: searchQuery,
        returnedResultCount: results.length,
        resultCount: acceptedResults.length,
        siteRejectedCount: rejectedForSite,
        newUrlCount: addedThisQuery,
        gapId,
        fallback: fallbackQueries.has(searchQuery),
        outcome: outcome.outcome,
      });
      addTrace(trace, state, 'search', buildExecutedSearchTrace({
        query: searchQuery,
        queryOrigin: item.queryOrigin || action.queryOrigin || 'llm_planner',
        plannerMode: item.plannerMode || action.plannerMode || null,
        plannedQueries: planned ? [planned] : (action.plannedQueries || null),
        searchOptions,
        sources: acceptedResults,
        searchMeta,
        resultCount: acceptedResults.length,
        returnedResultCount: results.length,
        siteRejectedCount: rejectedForSite,
        newUrlCount: addedThisQuery,
        memoryStatus: memoryEntry?.status || null,
        error,
        skipped: memoryEntry?.status === 'duplicate_results' ? 'duplicate_results' : null,
        targetGapIds: [gapId],
        reasonCode: isTransientSearchError(error)
          ? (error.code === 'rate_limited' ? 'rate_limited' : 'provider_error')
          : (error
            ? 'search_failed'
            : (memoryEntry?.status === 'duplicate_results'
              ? 'duplicate_results'
              : (acceptedResults.length > 0 ? 'executed_search' : (rejectedForSite > 0 ? 'site_filtered_all' : 'empty_results')))),
        siteFallbackOf: item.siteFallbackOf || null,
      }), budget, error ? 'failed' : (memoryEntry?.status === 'duplicate_results' ? 'skipped' : (acceptedResults.length ? 'success' : 'filtered')));
    }
    await observeRerank({
      state,
      gap,
      providers: researchProviders,
      signal,
      trace,
      budget,
      relevance: readPolicy.relevance,
    });
    state.addDiary(`searched ${searchResults.length} quer${searchResults.length === 1 ? 'y' : 'ies'}, +${state.candidates.size - candidatesBefore} candidates`);
    addTrace(trace, state, 'search', {
      reasonCode: action.reasonCode || 'agent_search',
      targetGapIds: [gapId],
      query: allowedQueries[0] || action.query || null,
      queries: allowedQueries,
      queryOrigin: action.queryOrigin || (action.query === state.query ? 'user_query' : 'llm_planner'),
      plannerMode: action.plannerMode || null,
      plannedQueries: action.plannedQueries || null,
      queryCount: searchResults.length,
      resultCount: totalResults,
      returnedResultCount: returnedResults,
      siteRejectedCount: siteRejectedResults,
      newUrlCount: newUrls,
      decisionStep: true,
    }, budget);

    if (newUrls === 0 && totalResults === 0) {
      state.addDiary(`empty search for ${gapId}; planner may rewrite later`);
    }

    if (!state.scheduler && (autoReadTopK > 0 || duplicateSerp)) {
      let autoReadCount = duplicateSerp ? Math.max(1, autoReadTopK) : autoReadTopK;
      while (budget && autoReadCount > 0 && !budget.canClaim('sourceReads', autoReadCount)) autoReadCount -= 1;
      const picks = autoReadCount > 0 ? pickUnreadCandidates(state, autoReadCount, gapId) : [];
      if (picks.length) {
        successfulAutoReads += (await performRead({
          sourceIds: picks.map((candidate) => candidate.id).slice(0, autoReadCount),
          gapId,
          reasonCode: 'auto_read_top_ranked',
          harvest: true,
        })).successful;
        if (duplicateSerp) {
          addTrace(trace, state, 'duplicate_serp_redirect', {
            reasonCode: 'read_unread_candidate',
            targetGapIds: [gapId],
            sourceIds: picks.map((candidate) => candidate.id),
          }, budget);
        }
      } else if (duplicateSerp) {
        markRepairAngleExhausted(gap, searchQueries);
        addTrace(trace, state, 'duplicate_serp_redirect', {
          reasonCode: 'angle_exhausted_rotate_slot',
          targetGapIds: [gapId],
        }, budget, 'skipped');
      }
    }
    return { gap, gapId, newUrls, totalResults, successfulAutoReads, searchResults, duplicateSerp };
  };
  performSearch.canReuse = canReuse;
  return performSearch;
}
