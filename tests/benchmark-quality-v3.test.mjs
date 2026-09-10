import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EvidenceStore } from 'js-deepresearch-engine';
import { reviewItems } from '../scripts/benchmark/quality/item-review.mjs';
import { criterionFromChecks, aggregateScore } from '../scripts/benchmark/quality/score.mjs';
import { verifyFacts, evaluate } from '../scripts/benchmark/quality/evaluate.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';

const gold = { goldHash: 'fixture', sources: [{ id: 's', text: 'A supports B.' }], criteria: [
 { id: 'criterion', weight: 1, core: true, critical: true, qualifiers: ['version'], anchors: [{ sourceId: 's', span: [0, 13] }] }] };
const artifact = { report: 'The run is incomplete.', reportHash: 'r', result: { quality: { completionStatus: 'incomplete' } },
 pin: {}, store: new EvidenceStore(), registry: { entries: [] } };
const fact = (id, kind = 'fact') => ({ id, kind, proposition: id, citationKeys: [] });
const verdict = (id, extra = {}) => ({ id, truth: 'correct', majorError: false, citations: [], goldEvidenceIds: ['G1'], ...extra });

test('deterministic checks forbid undeclared partial and force no-conflict applicability', () => {
 const c = { id: 'c', qualifiers: ['version'] };
 const check = { answer: 'present', qualifiers: [{ id: 'q1', met: true }], factIds: ['f'], missingMinor: true, conflict: 'wrong' };
 assert.equal(criterionFromChecks(c, check).verdict, 'incorrect');
 assert.equal(criterionFromChecks(c, check).conflict, 'not_applicable');
 assert.equal(criterionFromChecks({ ...c, partialCredit: 'example' }, check).verdict, 'partial');
 assert.equal(criterionFromChecks({ ...c, partialCredit: 'example' }, { ...check, qualifiers: [{ id: 'q1', met: false }] }).verdict, 'incorrect');
 assert.throws(() => criterionFromChecks(c, { ...check, qualifiers: [] }), /exact/);
});

test('an invalid item cannot discard accepted sibling judgments; restart makes zero calls', async t => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-review-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 const batches = [];
 const judge = { directory, identity: {}, async ask(_, __, input) {
   batches.push(input.facts.map(f => f.id));
   return { facts: input.facts.map(f => ({ id: f.id, ok: f.id === 'a' || batches.length > 1 })) };
 } };
 const args = { judge, purpose: 'test', field: 'facts', instructions: 'fixture', input: { facts: [{ id: 'a' }, { id: 'b' }] },
 validateItem: f => assert.equal(f.ok, true), pendingItem: f => ({ ...f, pending: true }) };
 const first = await reviewItems(args);
 assert.deepEqual(batches, [['a', 'b'], ['b']]);
 judge.ask = () => assert.fail('accepted checkpoint must avoid calls');
 assert.deepEqual(await reviewItems(args), first);
});

test('duplicate response IDs invalidate the envelope even if a sibling looks valid', async () => {
 let calls = 0;
 const result = await reviewItems({ judge: { async ask() { calls++; return { facts: [{ id: 'a' }, { id: 'a' }] }; } },
 purpose: 'fixture', field: 'facts', input: { facts: [{ id: 'a' }, { id: 'b' }] }, validateItem() {},
 pendingItem: f => ({ ...f, pending: true }) });
 assert.equal(calls, 2); assert.ok(result.every(f => f.pending));
});

test('operational facts see execution evidence only, technical facts cannot use those IDs', async () => {
 const inputs = [];
 const judge = { async ask(_, __, input) {
  inputs.push(input);
  return { facts: input.facts.map(f => verdict(f.id, input.operational
   ? { goldEvidenceIds: [], executionEvidenceIds: ['E-execution'] } : {})) };
 } };
 const result = await verifyFacts({ artifact, gold, facts: [fact('tech'), fact('status', 'execution_status')], caseDefinition: {}, judge });
 assert.deepEqual(result.map(f => f.truth), ['correct', 'correct']);
 assert.equal(inputs[0].executionEvidence, undefined); assert.ok(inputs[0].goldEvidence.length);
 assert.equal(inputs[1].goldEvidence, undefined); assert.ok(inputs[1].executionEvidence.length);
});

test('correct without checked evidence stays pending after bounded item repair', async () => {
 let calls = 0;
 const judge = { async ask(_, __, input) { calls++; return { facts: input.facts.map(f => verdict(f.id, { goldEvidenceIds: [], executionEvidenceIds: ['E-execution'] })) }; } };
 const result = await verifyFacts({ artifact, gold, facts: [fact('tech')], caseDefinition: {}, judge });
 assert.equal(calls, 2); assert.equal(result[0].truth, 'pending_review');
});

test('status-only reports have N/A technical accuracy and zero answer coverage', async () => {
 const judge = { usage: () => ({}), async ask(purpose, _, input) {
  if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
   facts: [{ quote: b.text, proposition: b.text, kind: 'execution_status', citationKeys: [] }] })) };
  if (purpose === 'audit_extraction') return { blocks: input.blocks.map(b => ({ id: b.id,
   checks: b.units.map(u => ({ id: u.id, status: 'covered', factIndexes: [0] })) })) };
  assert.equal(purpose, 'verify_facts');
  return { facts: input.facts.map(f => verdict(f.id, { goldEvidenceIds: [], executionEvidenceIds: ['E-execution'] })) };
 } };
 const score = await evaluate({ artifact, gold, caseDefinition: {}, judge });
 assert.equal(score.metrics.strictFactAccuracy, null); assert.equal(score.metrics.correctCoverage, 0);
 assert.equal(score.qualityTargetMet, false); assert.equal(score.metrics.statementCount, 1);
});

test('failed extraction remains visible instead of certifying the extracted subset', () => {
 const score = aggregateScore({ gold, facts: [fact('f')], extractionComplete: false,
 judgments: { facts: [verdict('f')], criteria: [{ id: 'criterion', verdict: 'correct', factIds: ['f'], conflict: 'not_applicable' }] } });
 assert.equal(score.metrics.strictFactAccuracy, null); assert.equal(score.metrics.pendingReview, true);
 assert.equal(score.metrics.coverageUpperBound, 1); assert.equal(score.qualityTargetMet, false);
});

test('judge wall-clock budget survives recovery and blocks new external calls', async t => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-judge-time-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify({ calls: { old: { tokens: 3, reserved: 100, activeMs: 50 } } }));
 const judge = new Judge({ directory, identity: {}, wallClockMs: 50, llm: { completeWithMetadata() { assert.fail(); } } });
 await assert.rejects(judge.ask('test', 'fixture', {}, () => {}), /WALL_CLOCK/);
 assert.equal(judge.usage().confirmedTokens, 3);
});
