export async function searchQuestion({ question, search, signal }) {
  const sources = await search.search(question, { signal });
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
}) {
  const uniqueQuestions = uniqueNonEmptyStrings(questions);
  if (uniqueQuestions.length === 0) return [];

  const maxConcurrency = normalizeConcurrency(concurrency, uniqueQuestions.length);
  const results = new Array(uniqueQuestions.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < uniqueQuestions.length) {
      const index = nextIndex;
      nextIndex += 1;
      const question = uniqueQuestions[index];

      try {
        results[index] = await searchQuestion({ question, search, signal });
      } catch (error) {
        results[index] = { question, sources: [], error };
      } finally {
        completed += 1;
        onProgress({ question, completed, total: uniqueQuestions.length });
      }
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return results;
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
