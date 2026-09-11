import { hash, invariant } from './schema.mjs';
import { evidenceCatalog, resolveLocator } from './locators.mjs';
import { reviewMaterialDecisions, RELATION_DECISION_VERSION } from './relation-decision.mjs';
import { STATEMENT_KINDS } from './statements.mjs';
export const BOUNDARY_STAGE = { id: 'relation_diagnostics', count: 24, tokens: 60000, wallClockMs: 900000 };
export function validateBoundaryFixture(fixture) {
  invariant(fixture.schemaVersion === 2 && fixture.relationDecisionVersion === RELATION_DECISION_VERSION
    && fixture.cases?.length === BOUNDARY_STAGE.count && new Set(fixture.cases.map(c => c.id)).size === BOUNDARY_STAGE.count, 'Invalid boundary diagnostics');
  for (const c of fixture.cases) invariant(c.proposition && c.sourceText?.includes(c.quote) && c.source?.id
    && (c.kind === undefined || STATEMENT_KINDS.includes(c.kind))
    && ['full_support', 'partial_support', 'contradiction', 'not_addressed'].includes(c.expected?.relation), 'Invalid boundary oracle');
}
export function checkBoundaryDiagnostics(fixture, results) {
  const rows = fixture.cases.map(c => {
    const r = results.find(r => r.id === c.id), kinds = [...new Set((r?.relations || []).map(e => e.relation))].sort();
    const observedRelation = kinds.length === 1 ? kinds[0] : kinds.length ? 'conflicting_evidence' : 'not_addressed';
    return { id: c.id, expectedRelation: c.expected.relation, observedRelation,
      matched: Boolean(r?.decisionStatus === 'confirmed' && r.coverage === 'complete' && observedRelation === c.expected.relation) };
  });
  return { rows, passed: results.length === fixture.cases.length && new Set(results.map(r => r.id)).size === results.length && rows.every(r => r.matched) };
}
export async function runBoundaryDiagnostics({ fixture, judge, freezeHash }) {
  validateBoundaryFixture(fixture);
  const checks = fixture.cases.map(c => {
    const source = { ...c.source, text: c.sourceText }, catalog = evidenceCatalog(source);
    const candidates = Array.isArray(c.initialCandidates) && c.initialCandidates.length === 0 ? []
      : [resolveLocator({ unitId: catalog.units[0].id, quote: c.quote }, catalog)];
    return { id: c.id, proposition: c.proposition, kind: c.kind ?? 'fact', source, catalog, candidates };
  });
  // Presentation variants test semantic relation invariance here; full report
  // extraction and binding variation are independently exercised in tests.
  const results = await reviewMaterialDecisions({ checks, judge, reportHash: hash(checks) });
  return { freezeHash, fixtureHash: hash(fixture), results, ...checkBoundaryDiagnostics(fixture, results) };
}
