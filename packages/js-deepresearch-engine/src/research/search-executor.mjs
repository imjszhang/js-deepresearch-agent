export async function mapLimit(items, concurrency, iteratee, signal) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const maxConcurrency = normalizeConcurrency(concurrency, list.length);

  async function worker() {
    while (nextIndex < list.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iteratee(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return results;
}

export async function searchQuestion({ question, search, signal, queryMemory, gapId = null, onSkip = () => {} }) {
  const duplicate = await queryMemory?.findDuplicate(question, gapId);
  if (duplicate) {
    onSkip({ question, duplicateOf: duplicate.entry.query, score: duplicate.score });
    return { question, sources: [], skipped: 'duplicate_query' };
  }
  const sources = await search.search(question, { signal });
  queryMemory?.record({ query: question, gapId, provider: search.id || '', status: sources?.length ? 'useful' : 'empty', results: Array.isArray(sources) ? sources : [] });
  return {
    question,
    sources: Array.isArray(sources) ? sources : [],
  };
}

export async function searchQuestions({
  questions,
  search,
  signal,
  concurrency = 1,
  onProgress = () => {},
  onSkip = () => {},
  queryMemory,
  gapId = null,
}) {
  const uniqueQuestions = uniqueNonEmptyStrings(questions);
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

      try {
        results[index] = await searchQuestion({ question, search, signal, queryMemory, gapId, onSkip });
      } catch (error) {
        if (isAbortError(error)) throw error;
        queryMemory?.record({ query: question, gapId, provider: search.id || '', status: 'failed', results: [] });
        results[index] = { question, sources: [], error: serializeSearchError(error) };
      } finally {
        completed += 1;
        onProgress({ question, completed, total: uniqueQuestions.length });
      }
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return results;
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

function serializeSearchError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
  };
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const unique = [];

  for (const value of values || []) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }

  return unique;
}

function normalizeConcurrency(concurrency, total) {
  const value = Number(concurrency);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), total);
}
