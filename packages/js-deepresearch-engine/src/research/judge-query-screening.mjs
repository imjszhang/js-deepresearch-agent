export const JUDGE_QUERY_SCREENING_PURPOSE = 'judge_query_screening';

const MAX_SEARCHED_COMPARISONS = 10;

function facetsOf(gap) {
  const facets = (gap?.slotSupport?.missingFacets || []).map((item) => String(item || '').trim()).filter(Boolean);
  return facets.length ? [...new Set(facets)] : [String(gap?.question || '').trim()].filter(Boolean);
}

function chunk(entries, size) {
  const out = [];
  for (let index = 0; index < entries.length; index += size) out.push(entries.slice(index, index + size));
  return out;
}

/**
 * Screens planner queries without touching their text: each query is scored for
 * whether it targets the gap's missing facts (sort key only) and compared with
 * queries this gap already searched (same intent above threshold = duplicate).
 * Unanswered questions leave the original order and admission untouched.
 */
export async function screenPlannedQueries(judge, { gap, queries = [], searched = [], signal } = {}) {
  const unchanged = { ordered: [...queries], duplicates: [], scores: new Map(), trace: null };
  if (!judge?.enabled?.('queryScreening') || !gap || !queries.length) return unchanged;
  const texts = [...new Set(queries.map((item) => String(item)))];
  const previous = [...new Set(searched.map((item) => String(item)))].filter((item) => !texts.includes(item)).slice(-MAX_SEARCHED_COMPARISONS);
  const entries = [];
  texts.forEach((_, index) => {
    entries.push([`q${index}_target`, { type: 'noul', instructions: `Does search query \`q${index}\` in \`queries\` target the facts listed in \`facets\`?` }]);
    previous.forEach((__, seenIndex) => {
      entries.push([`q${index}_same_s${seenIndex}`, { type: 'noul', instructions: `Do search query \`q${index}\` in \`queries\` and already searched query \`s${seenIndex}\` in \`searched\` express the same search intent?` }]);
    });
  });
  const state = {
    question: gap.question || '',
    facets: facetsOf(gap),
    queries: texts.map((text, index) => ({ ref: `q${index}`, text })),
    searched: previous.map((text, index) => ({ ref: `s${index}`, text })),
  };
  const answers = {};
  const trace = { judge: judge.identityKey, requests: 0, degraded: 0, errorCodes: [] };
  for (const group of chunk(entries, judge.batchSize)) {
    const result = await judge.judge({ purpose: JUDGE_QUERY_SCREENING_PURPOSE, signal, state, questions: Object.fromEntries(group) });
    if (result.status !== 'completed') {
      trace.degraded += 1;
      if (result.errorCode) trace.errorCodes.push(result.errorCode);
      continue;
    }
    if (!result.cached) trace.requests += 1;
    Object.assign(answers, result.answers);
  }
  const scores = new Map();
  const duplicates = [];
  texts.forEach((text, index) => {
    if (answers[`q${index}_target`]) scores.set(text, answers[`q${index}_target`].noul);
    let best = null;
    previous.forEach((seen, seenIndex) => {
      const probability = answers[`q${index}_same_s${seenIndex}`]?.noul;
      if (probability >= judge.thresholds.duplicateIntent && (!best || probability > best.probability)) best = { duplicateOf: seen, probability };
    });
    if (best) duplicates.push({ query: text, reason: 'jev_intent', ...best });
  });
  const excluded = new Set(duplicates.map((item) => item.query));
  const kept = queries.filter((item) => !excluded.has(String(item)));
  const ordered = scores.size === texts.length
    ? kept.map((item, index) => ({ item, index })).sort((a, b) => scores.get(String(b.item)) - scores.get(String(a.item)) || a.index - b.index).map((entry) => entry.item)
    : kept;
  return { ordered, duplicates, scores, trace };
}

export function applyQueryScreening(items, screening, textOf = (item) => item) {
  const excluded = new Set(screening.duplicates.map((item) => item.query));
  const rank = new Map();
  screening.ordered.forEach((item, index) => { if (!rank.has(String(item))) rank.set(String(item), index); });
  return items.map((item, index) => ({ item, index }))
    .filter(({ item }) => !excluded.has(String(textOf(item))))
    .sort((a, b) => rank.get(String(textOf(a.item))) - rank.get(String(textOf(b.item))) || a.index - b.index)
    .map(({ item }) => item);
}
