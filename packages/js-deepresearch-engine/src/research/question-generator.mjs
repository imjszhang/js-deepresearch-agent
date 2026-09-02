import { planSearchQueries, QUERY_ORIGINS } from './search-query-planner.mjs';

export async function generatePlannedQuestions({
  llm,
  query,
  count,
  signal,
  mode = 'initial',
  context = '',
  brief = {},
  evidenceScope = 'web',
  searchedQueries = [],
  rejectedQueries = [],
  recentSearchOutcomes = [],
  queryMemory = null,
} = {}) {
  const resolvedCount = Number(count);
  if (!Number.isFinite(resolvedCount) || resolvedCount <= 0) return [];
  const planned = await planSearchQueries({
    llm,
    signal,
    mode: 'initial',
    query,
    brief,
    limit: resolvedCount,
    evidenceScope,
    searchedQueries,
    rejectedQueries,
    recentSearchOutcomes,
    queryMemory,
    context,
    hints: mode === 'initial' ? [] : [],
  });
  if (planned.ok) return planned.planned.slice(0, resolvedCount);
  return [];
}

export async function generateQuestions(options = {}) {
  return (await generatePlannedQuestions(options)).map((item) => item.query);
}

export function userQueryEntry(query) {
  return {
    query: String(query || '').trim(),
    queryOrigin: QUERY_ORIGINS.userQuery,
    plannerMode: null,
    plannerPurpose: null,
    targetGapId: null,
    searchOptions: null,
  };
}

export function formatSourcesForQuestionContext(findings, limit = 12) {
  const sources = [];
  for (const finding of findings || []) {
    for (const source of finding.sources || []) {
      sources.push(source);
    }
  }

  return sources.slice(-limit).map((source, index) => {
    const title = source.title || 'Untitled';
    const url = source.url || '';
    const snippet = source.snippet || '';
    return `Source ${index + 1}: ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  }).join('\n\n');
}
