import { exactIds, invariant } from './schema.mjs';
import { isTechnical, isAnswer, isExecutionStatement, STATEMENT_KINDS } from './statements.mjs';

export const TRUTH = ['correct', 'partial', 'incorrect', 'unverifiable', 'pending_review'];
export const COVERAGE = ['correct', 'partial', 'incorrect', 'missing', 'pending_review'];
const points = { correct: 1, partial: 0.5, incorrect: 0, missing: 0, unverifiable: 0, pending_review: 0 };
const rate = (a, b) => b ? a / b : null;

export function criterionFromChecks(criterion, check) {
  invariant(['present', 'absent', 'contradicted', 'unknown'].includes(check.answer)
    && typeof check.missingMinor === 'boolean' && Array.isArray(check.factIds), 'Invalid criterion checks');
  const ids = (criterion.qualifiers || []).map((_, index) => `q${index + 1}`);
  exactIds(check.qualifiers, ids);
  invariant(check.qualifiers.every(q => [true, false, null].includes(q.met)), 'Invalid qualifier check');
  const conflict = criterion.conflictCase ? check.conflict : 'not_applicable';
  invariant(!criterion.conflictCase || ['resolved', 'wrong', 'missing', 'pending_review'].includes(conflict), 'Missing conflict evaluation');
  let verdict;
  if (check.answer === 'unknown' || check.qualifiers.some(q => q.met === null)) verdict = 'pending_review';
  else if (check.answer === 'absent') verdict = 'missing';
  else if (check.answer === 'contradicted' || check.qualifiers.some(q => q.met === false)) verdict = 'incorrect';
  else verdict = check.missingMinor ? (criterion.partialCredit ? 'partial' : 'incorrect') : 'correct';
  invariant(verdict === 'missing' ? check.factIds.length === 0 : ['pending_review', 'incorrect'].includes(verdict) || check.factIds.length > 0, 'Coverage without facts');
  return { id: criterion.id, verdict, factIds: check.factIds, conflict, checks: check };
}

export function validateJudgments(gold, facts, judgments) {
  exactIds(judgments.criteria, gold.criteria.map(c => c.id));
  exactIds(judgments.facts, facts.map(f => f.id));
  for (const f of judgments.facts) {
    invariant(TRUTH.includes(f.truth) && typeof f.majorError === 'boolean', 'Invalid fact verdict');
    const original = facts.find(x => x.id === f.id);
    exactIds(f.citations, original.citationKeys, 'key');
    invariant(f.citations.every(c => ['supported', 'partial', 'unsupported', 'unresolved', 'pending_review'].includes(c.verdict)), 'Invalid citation verdict');
  }
  for (const j of judgments.criteria) {
    invariant(COVERAGE.includes(j.verdict) && Array.isArray(j.factIds) && new Set(j.factIds).size === j.factIds.length
      && j.factIds.every(id => facts.some(f => f.id === id)), 'Invalid coverage verdict');
    invariant(['resolved', 'wrong', 'missing', 'pending_review', 'not_applicable'].includes(j.conflict), 'Invalid conflict verdict');
    invariant(j.verdict === 'missing' ? j.factIds.length === 0 : ['pending_review', 'incorrect'].includes(j.verdict) || j.factIds.length > 0, 'Coverage without report facts');
    const c = gold.criteria.find(c => c.id === j.id);
    invariant(j.factIds.every(id => isAnswer(facts.find(f => f.id === id))), 'Execution/scope statements cannot satisfy content criteria');
    invariant(!c.conflictCase || j.conflict !== 'not_applicable', 'Missing conflict evaluation');
    invariant(c.conflictCase || j.conflict === 'not_applicable', 'Unexpected conflict evaluation');
    if (j.verdict === 'partial') invariant(Boolean(c.partialCredit), 'Partial credit not predefined');
  }
}

export function aggregateScore({ gold, facts, judgments, variant = 'explicit', requirements = [], cost = null, humanReview = null, extractionComplete = true }) {
  validateJudgments(gold, facts, judgments);
  const factMap = new Map(judgments.facts.map(f => [f.id, f]));
  const rows = gold.criteria.map(c => {
    const j = judgments.criteria.find(j => j.id === c.id);
    const matched = j.factIds.map(id => factMap.get(id));
    const pending = !extractionComplete || j.verdict === 'pending_review' || matched.some(f => f.truth === 'pending_review');
    // A semantic matcher cannot override an independent failed fact verification.
    const value = j.factIds.length && (!c.conflictCase || j.conflict === 'resolved') ? Math.min(points[j.verdict], ...matched.map(f => points[f.truth])) : 0;
    const supported = matched.length > 0 && matched.every(f => f.citations.some(c => c.verdict === 'supported'));
    return { id: c.id, core: c.core, critical: c.critical, weight: c.weight, verdict: j.verdict,
      factIds: j.factIds, points: value, evidencePoints: supported ? value : 0, pending,
      conflict: c.conflictCase ? j.conflict : null, requirementIds: c.requirementIds || [] };
  });
  const coverage = (selected, field) => rate(selected.reduce((n, r) => n + r.weight * r[field], 0), selected.reduce((n, r) => n + r.weight, 0));
  const core = rows.filter(r => r.core);
  const pendingWeight = rows.filter(r => r.pending).reduce((n, r) => n + r.weight, 0);
  const totalWeight = rows.reduce((n, r) => n + r.weight, 0);
  const citations = judgments.facts.flatMap(f => f.citations);
  const conflict = rows.filter(r => r.conflict);
  const technicalIds = new Set(facts.filter(isTechnical).map(f => f.id));
  const technical = judgments.facts.filter(f => technicalIds.has(f.id));
  const factCounts = Object.fromEntries(TRUTH.map(v => [v, technical.filter(f => f.truth === v).length]));
  const majorErrors = [...new Set([
    ...technical.filter(f => f.majorError && f.truth === 'incorrect').map(f => f.id),
    ...rows.filter(r => r.critical).flatMap(r => r.factIds.filter(id => factMap.get(id).truth === 'incorrect')),
  ])];
  const pending = !extractionComplete || rows.some(r => r.pending) || judgments.facts.some(f => f.truth === 'pending_review')
    || citations.some(c => c.verdict === 'pending_review') || conflict.some(c => c.conflict === 'pending_review');
  const requirementRows = requirements.map(req => {
    const linked = rows.filter(r => r.requirementIds.includes(req.id));
    return { id: req.id, complete: linked.length > 0 && linked.every(r => r.points === 1 && !r.pending) };
  });
  const metrics = {
    correctCoverage: coverage(rows, 'points'), evidenceCoverage: coverage(rows, 'evidencePoints'),
    coreCorrectCoverage: coverage(core, 'points'), coreEvidenceCoverage: coverage(core, 'evidencePoints'),
    coverageUpperBound: extractionComplete ? Math.min(1, (rows.reduce((n, r) => n + r.weight * r.points, 0) + pendingWeight) / totalWeight) : 1,
    explicitRequirementCompletion: variant === 'explicit' ? rate(requirementRows.filter(r => r.complete).length, requirementRows.length) : null,
    statementCount: facts.length, statementCountsByKind: Object.fromEntries(STATEMENT_KINDS.map(kind => [kind, facts.filter(f => (f.kind || 'fact') === kind).length])),
    executionStatementErrors: judgments.facts.filter(f => isExecutionStatement(facts.find(x => x.id === f.id)) && f.truth === 'incorrect').length,
    extractionComplete,
    factCount: technical.length, factCounts, strictFactAccuracy: extractionComplete ? rate(factCounts.correct, technical.length) : null,
    factVerificationCoverage: extractionComplete ? rate(technical.length - factCounts.unverifiable - factCounts.pending_review, technical.length) : null,
    citationCount: citations.length, citationSupportRate: rate(citations.filter(c => c.verdict === 'supported').length, citations.length),
    uncitedFactRate: rate(technical.filter(f => f.citations.length === 0).length, technical.length),
    sufficientlySupportedFactRate: rate(technical.filter(f => f.citations.some(c => c.verdict === 'supported')).length, technical.length),
    conflictResolutionRate: rate(conflict.filter(c => c.conflict === 'resolved').length, conflict.length),
    majorErrorCount: majorErrors.length, pendingReview: pending,
  };
  const coveragePass = variant === 'explicit' ? metrics.correctCoverage >= 0.9 && metrics.evidenceCoverage >= 0.85
    : metrics.coreCorrectCoverage >= 0.8 && metrics.coreEvidenceCoverage >= 0.75;
  const qualityTargetMet = coveragePass && majorErrors.length === 0 && !pending && metrics.strictFactAccuracy >= 0.95
    && metrics.factVerificationCoverage >= 0.95 && metrics.citationSupportRate >= 0.95
    && conflict.every(c => c.conflict === 'resolved') && rows.filter(r => r.critical).every(r => r.evidencePoints === 1);
  return { metrics, rows, requirementRows, majorErrors, qualityTargetMet,
    reviewStatus: pending ? 'pending_review' : humanReview?.complete ? 'human_reviewed' : 'machine_draft',
    humanReview: humanReview || { complete: false, reviewedFactIds: [], reviewedCriterionIds: [] }, cost };
}
