import { exactIds, invariant, span } from './schema.mjs';
import { STATEMENT_KINDS } from './statements.mjs';
import { TRUTH } from './score.mjs';

const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] >= inner[1];
export function validateOracle(item) {
  invariant(Array.isArray(item.expectedAssertions), 'Missing per-assertion oracle');
  exactIds(item.expectedAssertions, [...new Set(item.expectedAssertions.map(a => a.id))]);
  for (const a of item.expectedAssertions) {
    span(item.report, a.span); span(item.report, a.allowedSpan);
    invariant(contains(a.allowedSpan, a.span) && a.kinds?.length && a.kinds.every(k => STATEMENT_KINDS.includes(k))
      && TRUTH.includes(a.truth) && a.truth !== 'pending_review' && typeof a.critical === 'boolean', 'Invalid assertion oracle');
    for (const range of a.requiredSpans || []) span(item.report, range);
    invariant(Array.isArray(a.citations) && a.citations.every(c => typeof c.key === 'string'
      && ['supported', 'partial', 'unsupported', 'unresolved'].includes(c.verdict)), 'Invalid citation oracle');
    exactIds(a.citations, [...new Set(a.citations.map(c => c.key))], 'key');
  }
  if (item.mode === 'score') {
    invariant(item.expectedCriteria?.length && item.expectedMetrics && typeof item.expectedMetrics === 'object', 'Missing scoring oracle');
    exactIds(item.expectedCriteria, item.criteria.map(c => c.id));
    for (const c of item.expectedCriteria) invariant(['correct', 'partial', 'incorrect', 'missing'].includes(c.verdict)
      && [0, 0.5, 1].includes(c.points) && [0, 0.5, 1].includes(c.evidencePoints), 'Invalid scoring oracle');
  }
}

export function checkOracle(item, score) {
  // Match individual occurrences, so duplicate text cannot hide a missed line.
  const occurrences = score.facts.flatMap(f => (f.occurrences || [f.span]).map(range => ({ fact: f, range,
    contextSpans: f.occurrenceCitations?.find(o => o.span[0] === range[0] && o.span[1] === range[1])?.contextSpans || f.contextSpans || [],
    citations: f.occurrenceCitations?.find(o => o.span[0] === range[0] && o.span[1] === range[1])?.citationKeys || f.citationKeys })));
  const matches = item.expectedAssertions.map(a => occurrences.map((o, i) => ({ ...o, index: i }))
    .filter(o => contains(o.range, a.span) && contains(a.allowedSpan, o.range)
      && (a.requiredSpans || []).every(r => [o.range, ...o.contextSpans].some(s => contains(s, r)))));
  const used = new Set(), assertions = [];
  for (let index = 0; index < item.expectedAssertions.length; index++) {
    const expected = item.expectedAssertions[index], candidates = matches[index];
    const unique = candidates.length === 1 && !used.has(candidates[0].index)
      && matches.filter(list => list.some(o => o.index === candidates[0].index)).length === 1;
    const occurrence = unique ? candidates[0] : null;
    if (occurrence) used.add(occurrence.index);
    const fact = occurrence?.fact, judgment = score.judgments.facts.find(f => f.id === fact?.id);
    const citationsMatch = occurrence && occurrence.citations.length === expected.citations.length
      && expected.citations.every(c => occurrence.citations.includes(c.key) && judgment?.citations.some(j => j.key === c.key && j.verdict === c.verdict));
    assertions.push({ id: expected.id, matched: Boolean(unique && expected.kinds.includes(fact.kind) && judgment?.truth === expected.truth && citationsMatch),
      covered: Boolean(unique), expected: expected.truth, observed: judgment?.truth || null, kind: fact?.kind || null,
      citationsMatch: Boolean(citationsMatch), criticalMiss: Boolean(['incorrect', 'unverifiable'].includes(expected.truth) && judgment?.truth === 'correct'),
      boundaryMiss: Boolean(expected.critical && expected.truth === 'unverifiable' && judgment?.truth === 'incorrect') });
  }
  const extraAssertions = occurrences.length - used.size;
  const criteria = (item.expectedCriteria || []).map(e => {
    const row = score.rows?.find(r => r.id === e.id);
    return { id: e.id, matched: Boolean(row && ['verdict', 'points', 'evidencePoints'].every(k => row[k] === e[k])
      && (!Object.hasOwn(e, 'conflict') || row.conflict === e.conflict) && !row.pending) };
  });
  const metricChecks = Object.entries(item.expectedMetrics || {}).map(([key, expected]) => ({ key,
    matched: typeof expected === 'number' ? typeof score.metrics?.[key] === 'number' && Math.abs(score.metrics[key] - expected) <= 1e-10
      : score.metrics?.[key] === expected }));
  const complete = score.extractionComplete && !score.metrics?.pendingReview && !score.judgments.facts.some(f => f.truth === 'pending_review'
    || f.citations.some(c => c.verdict === 'pending_review'));
  return { id: item.id, complete, matched: Boolean(complete && !extraAssertions && assertions.every(a => a.matched)
    && criteria.every(c => c.matched) && metricChecks.every(m => m.matched)),
    assertions, extraAssertions, criteria, metricChecks,
    coverageComplete: Boolean(complete && !extraAssertions && assertions.every(a => a.covered)),
    criticalMiss: assertions.some(a => a.criticalMiss), boundaryMiss: assertions.some(a => a.boundaryMiss) };
}
