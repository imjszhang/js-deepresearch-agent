import { getSearchMeta } from '../search/search-result.mjs';
import { isTransientSearchError, serializeSearchError } from '../search/search-provider-error.mjs';

function questionText(item) {
  if (typeof item === 'string') return item;
  return String(item?.question || item?.query || '').trim();
}

function questionSearchOptions(item) {
  if (!item || typeof item === 'string') return undefined;
  return item.searchOptions || undefined;
}

export async function searchQuestion({
  question,
  search,
  signal,
  queryMemory,
  gapId = null,
  searchOptions,
  onSkip = () => {},
  onResult = () => {},
}) {
  const query = questionText(question);
  const options = searchOptions || questionSearchOptions(question);
  const duplicate = await queryMemory?.findDuplicate(query, gapId);
  if (duplicate) {
    onSkip({ question: query, duplicateOf: duplicate.entry.query, score: duplicate.score });
    const skipped = {
      question: query,
      searchQuery: query,
      sources: [],
      skipped: 'duplicate_query',
      searchOptions: options || null,
      searchMeta: null,
    };
    onResult(skipped);
    return skipped;
  }
  try {
    const sources = await search.search(query, { signal, searchOptions: options });
    const list = Array.isArray(sources) ? sources : [];
    const searchMeta = getSearchMeta(sources);
    queryMemory?.record({
      query,
      gapId,
      provider: search.id || '',
      status: list.length ? 'useful' : 'empty',
      results: list,
    });
    const result = {
      question: query,
      searchQuery: query,
      sources: list,
      searchOptions: options || null,
      searchMeta,
    };
    onResult(result);
    return result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!isTransientSearchError(error)) {
      queryMemory?.record({ query, gapId, provider: search.id || '', status: 'failed', results: [] });
    }
    const result = {
      question: query,
      searchQuery: query,
      sources: [],
      searchOptions: options || null,
      searchMeta: null,
      error: serializeSearchError(error),
    };
    onResult(result);
    return result;
  }
}

export async function searchQuestions({
  questions,
  search,
  signal,
  concurrency = 1,
  onProgress = () => {},
  onSkip = () => {},
  onResult = () => {},
  queryMemory,
  gapId = null,
}) {
  const uniqueQuestions = await uniqueQueriesForBatch(questions, queryMemory, onSkip);
  if (uniqueQuestions.length === 0) return [];

  const maxConcurrency = normalizeConcurrency(concurrency, uniqueQuestions.length);
  const results = new Array(uniqueQuestions.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < uniqueQuestions.length) {
      throwIfAborted(signal);

      const index = nextIndex;
      nextIndex += 1;
      const question = uniqueQuestions[index];

      results[index] = await searchQuestion({
        question,
        search,
        signal,
        queryMemory,
        gapId,
        onSkip,
        onResult,
      });
      completed += 1;
      onProgress({
        question: questionText(question),
        completed,
        total: uniqueQuestions.length,
      });
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return results;
}

async function uniqueQueriesForBatch(values, queryMemory, onSkip) {
  const exact = uniqueQuestionItems(values);
  if (!queryMemory?.enabled) return exact;
  const accepted = [];
  for (const item of exact) {
    let duplicate = null;
    const query = questionText(item);
    for (const seen of accepted) {
      const pair = await queryMemory.queriesMatch(query, questionText(seen));
      if (pair.match) {
        duplicate = { query: questionText(seen), score: pair.score };
        break;
      }
    }
    if (duplicate) {
      queryMemory.onSkip?.({ query, duplicateOf: duplicate.query, score: duplicate.score, reason: 'duplicate_batch_query' });
      onSkip({ question: query, duplicateOf: duplicate.query, score: duplicate.score });
    } else {
      accepted.push(item);
    }
  }
  return accepted;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Research aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function uniqueQuestionItems(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values || []) {
    const query = questionText(value);
    if (!query || seen.has(query)) continue;
    seen.add(query);
    unique.push(typeof value === 'string' ? query : { ...value, question: query, query });
  }
  return unique;
}

function normalizeConcurrency(concurrency, total) {
  const value = Number(concurrency);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), total);
}
