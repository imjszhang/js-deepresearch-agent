import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundaryDiagnostics, validateBoundaryFixture } from '../scripts/benchmark/quality/boundary-diagnostics.mjs';
import { RELATION_DECISION_VERSION } from '../scripts/benchmark/quality/relation-decision.mjs';

const fixture = () => ({ schemaVersion: 2, relationDecisionVersion: RELATION_DECISION_VERSION,
  cases: Array.from({ length: 24 }, (_, i) => ({ id: 'scripted-boundary-' + i, proposition: 'The attributed statement names a product.',
    ...(i % 3 === 0 ? { kind: 'attribution' } : i % 3 === 1 ? { kind: 'inference' } : {}),
    sourceText: 'Synthetic complete material.', quote: 'Synthetic complete material.', initialCandidates: [],
    source: { id: 'source-' + i, version: 'fixed' }, expected: { relation: 'not_addressed' } })) });

test('[V08] boundary diagnostics preserve explicit statement kinds and expose no oracle fields to the decision', async () => {
  const data = fixture(), seen = new Set();
  const result = await runBoundaryDiagnostics({ fixture: data, freezeHash: 'scripted', judge: {
    assessmentOrigin: 'scripted_fixture', async ask(purpose, _, input) {
      assert.ok(['decide_relations', 'audit_relation_decisions'].includes(purpose));
      for (const check of input.checks) {
        const original = data.cases.find(c => c.id === check.id);
        assert.equal(check.kind, original.kind ?? 'fact'); seen.add(check.id);
        assert.equal(check.expected, undefined); assert.equal(check.expectedRelation, undefined);
      }
      return { checks: input.checks.map(check => purpose === 'decide_relations'
        ? { id: check.id, coverage: 'complete', relations: [] }
        : { id: check.id, coverage: 'complete', anchors: [], omissions: 'none' }) };
    },
  } });
  assert.equal(seen.size, 24); assert.equal(result.results.length, 24);
  assert.ok(result.results.every(r => r.origin === 'scripted_fixture'));
});

test('boundary diagnostics reject prior protocol and unknown statement kinds', () => {
  const old = fixture(); old.relationDecisionVersion--;
  assert.throws(() => validateBoundaryFixture(old), /Invalid boundary/);
  const invalid = fixture(); invalid.cases[0].kind = 'program_proven_truth';
  assert.throws(() => validateBoundaryFixture(invalid), /Invalid boundary/);
});
