import { evidenceCatalog } from '../scripts/benchmark/quality/locators.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relationTruth, operationalTruth } from '../scripts/benchmark/quality/evidence-relations.mjs';
import { executionEvidence } from '../scripts/benchmark/quality/statements.mjs';
import { checkOracle } from '../scripts/benchmark/quality/calibration-oracle.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { reviewItems } from '../scripts/benchmark/quality/item-review.mjs';
import { readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { requireCalibration, calibrationQualification } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { verifyFacts } from '../scripts/benchmark/quality/evaluate.mjs';
import { EvidenceStore } from 'js-deepresearch-engine';
import { candidateResponse, decisionResponse, basisAuditResponse } from './helpers/quality-relations.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-v5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const evidence = [{ id: 'manual', text: 'Version 1 permits one writer. No measurements are supplied.' }];
const anchor = (relation = 'full_support') => ({ id: 'manual', quote: 'Version 1 permits one writer.', unitId: evidenceCatalog(evidence[0]).units[0].id, relation, object: 'same', version: 'same', conditions: 'compatible' });
test('relation mapping separates positive evidence, counterevidence, absence and conflict', () => {
  for (const [relation, truth] of Object.entries({ full_support: 'correct', partial_support: 'partial', contradiction: 'incorrect' })) {
    assert.equal(relationTruth({ relation, evidence: [anchor(relation)] }, evidence), truth);
  }
  assert.equal(relationTruth({ relation: 'not_addressed', evidence: [] }, evidence), 'unverifiable');
  assert.equal(relationTruth({ relation: 'full_support', evidence: [anchor(), anchor('contradiction')] }, evidence), 'pending_review');
  assert.throws(() => relationTruth({ relation: 'contradiction', evidence: [] }, evidence), /without direct anchor/);
  assert.throws(() => relationTruth({ relation: 'not_addressed', evidence: [anchor()] }, evidence), /Unaddressed/);
});
test('anchor existence, exact location, version and object must all validate', () => {
  for (const change of [{ id: 'absent' }, { span: [1, 29] }, { quote: 'invented' }, { version: 'different' }, { object: 'different' }, { conditions: 'unknown' }]) {
    assert.throws(() => relationTruth({ relation: 'contradiction', evidence: [{ ...anchor('contradiction'), ...change }] }, evidence));
  }
});
test('operational field comparison preserves missing vs zero and does not substitute body count', () => {
  const fields = executionEvidence({ result: { quality: { budget: { usage: { sourceReads: 0 } } } }, store: { versions: new Map([['v', {}]]), passages: new Map() } }, {});
  assert.equal(operationalTruth({ mapping: 'exact', fieldId: 'E-observations.sourceReads', assertedValue: 3 }, fields), 'incorrect');
  assert.equal(operationalTruth({ mapping: 'exact', fieldId: 'E-observations.sourceReads', assertedValue: 0 }, fields), 'correct');
  fields.find(f => f.field === 'sourceReads').state = 'missing';
  assert.equal(operationalTruth({ mapping: 'exact', fieldId: 'E-observations.sourceReads', assertedValue: 3 }, fields), 'unverifiable');
  assert.equal(operationalTruth({ mapping: 'uncertain' }, fields), 'pending_review');
  assert.throws(() => operationalTruth({ mapping: 'exact', fieldId: 'invented', assertedValue: 3 }, fields));
});
test('fact verification never supplies rubric answers as evidence or operational fields to technical facts', async () => {
  const store = new EvidenceStore(), artifact = { report: 'Technical.', reportHash: 'r', result: {}, store, registry: { entries: [] } };
  const gold = { sources: [{ id: 'manual', text: evidence[0].text }], criteria: [{ expectedAnswer: 'PRIVATE ANSWER', commonErrors: ['PRIVATE ERROR'], anchors: [{ sourceId: 'manual', span: [0, 29] }] }] };
  const result = await verifyFacts({ artifact, gold, caseDefinition: {}, facts: [{ id: 'f', kind: 'fact', proposition: 'Technical.', citationKeys: [] }], judge: { async ask(purpose, __, input) {
    assert.equal(input.gold, undefined); assert.equal(input.executionEvidence, undefined);
    assert.ok(!JSON.stringify(input).includes('PRIVATE'));
    if (purpose === 'find_evidence') return candidateResponse(input, () => false);
    if (purpose === 'decide_relations') return decisionResponse(input, () => null);
    assert.equal(purpose, 'audit_relation_decisions'); return basisAuditResponse(input);
  } } });
  assert.equal(result[0].truth, 'unverifiable');
});

function oracleFixture() {
  const assertions = ['correct', 'incorrect'].map((truth, i) => ({ id: 'a' + i, span: [i * 5, i * 5 + 4], allowedSpan: [i * 5, i * 5 + 4], kinds: ['fact'], truth, critical: true, citations: [] }));
  const facts = assertions.map((a, i) => ({ id: 'f' + i, span: a.span, occurrences: [a.span], kind: 'fact', citationKeys: [] }));
  return { item: { expectedAssertions: assertions }, score: { extractionComplete: true, facts,
    judgments: { facts: assertions.map((a, i) => ({ id: 'f' + i, truth: a.truth, citations: [] })) } } };
}
test('mixed oracle rejects omitted, added and broadly merged assertions instead of checking only retained truth labels', () => {
  const x = oracleFixture(); assert.equal(checkOracle(x.item, x.score).matched, true);
  x.score.facts.pop(); assert.equal(checkOracle(x.item, x.score).coverageComplete, false);
  const y = oracleFixture(); y.score.facts.push({ ...y.score.facts[0], id: 'extra' });
  assert.equal(checkOracle(y.item, y.score).matched, false);
  const z = oracleFixture(); z.score.facts = [{ ...z.score.facts[0], span: [0, 9], occurrences: [[0, 9]] }];
  assert.equal(checkOracle(z.item, z.score).matched, false);
});
test('oracle requires shared conditions, each duplicate occurrence and matching citation status', () => {
  const x = oracleFixture(); x.item.expectedAssertions[0].requiredSpans = [[10, 12]];
  assert.equal(checkOracle(x.item, x.score).matched, false);
  x.score.facts[0].contextSpans = [[10, 12]]; assert.equal(checkOracle(x.item, x.score).matched, true);
  x.score.facts[0].occurrences.push([20, 24]); assert.equal(checkOracle(x.item, x.score).matched, false);
  const y = oracleFixture(); y.item.expectedAssertions[0].citations = [{ key: '1.1', verdict: 'supported' }];
  assert.equal(checkOracle(y.item, y.score).matched, false);
});
test('complete scoring oracle checks each criterion and numeric metric independently', () => {
  const x = oracleFixture(); x.item.expectedCriteria = [{ id: 'c', verdict: 'correct', points: 1, evidencePoints: 0 }];
  x.item.expectedMetrics = { strictFactAccuracy: 0.5, pendingReview: false };
  x.score.rows = [{ ...x.item.expectedCriteria[0], pending: false }]; x.score.metrics = { strictFactAccuracy: 0.5, pendingReview: false };
  assert.equal(checkOracle(x.item, x.score).matched, true);
  x.score.rows[0].evidencePoints = 1; assert.equal(checkOracle(x.item, x.score).matched, false);
});
const reviewArgs = judge => ({ judge, purpose: 'fixture', instructions: 'test', field: 'facts', input: { facts: [{ id: 'a' }, { id: 'b' }] },
  validateItem: item => assert.equal(item.ok, true), pendingItem: (item, pendingReason) => ({ ...item, pendingReason }) });
test('production nested retry cannot dispatch any item more than twice, including restarts', async t => {
  const directory = temp(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata() { calls++; return { text: '{}', usage: { totalTokens: 10 } }; } } };
  const first = await reviewItems(reviewArgs(new Judge(options)));
  assert.equal(calls, 2); assert.ok(first.every(i => i.pendingReason));
  await reviewItems(reviewArgs(new Judge(options))); assert.equal(calls, 2);
});
test('a persisted unknown flight recovers a late response with no new dispatch or double settlement', async t => {
  const directory = temp(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata() { calls++; throw Error('lost connection'); } } };
  const judge = new Judge(options);
  const first = await reviewItems(reviewArgs(judge)); assert.ok(first.every(f => f.pendingReason === 'provider_pending'));
  await reviewItems(reviewArgs(judge)); assert.equal(calls, 1);
  const id = Object.keys(judge.ledger.calls)[0];
  writeJson(path.join(directory, id + '.json'), { text: JSON.stringify({ facts: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }), usage: { totalTokens: 15 }, activeMs: 1 });
  const restored = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail(); } } });
  assert.ok((await reviewItems(reviewArgs(restored))).every(f => f.ok));
  assert.equal(restored.usage().confirmedTokens, 15); assert.equal(restored.usage().unknownCalls, 0);
  assert.ok((await reviewItems(reviewArgs(restored))).every(f => f.ok)); assert.equal(restored.usage().confirmedTokens, 15);
});
test('stage budgets do not borrow, and policy changes cannot reset cumulative usage', async t => {
  const directory = temp(t), options = { directory, identity: {}, stages: { a: { tokens: 1, wallClockMs: 1000 }, b: { tokens: 100000, wallClockMs: 1000 } },
    llm: { async completeWithMetadata() { return { text: '{}', usage: { totalTokens: 10 } }; } } };
  const j = new Judge(options); j.setStage('a'); await assert.rejects(j.ask('fixture', '', {}, () => {}), /STAGE_BUDGET/);
  j.setStage('b'); await j.ask('fixture', '', {}, () => {});
  assert.equal(j.usage('a').confirmedTokens, 0); assert.equal(j.usage('b').confirmedTokens, 10);
  assert.throws(() => new Judge({ ...options, limit: 200000 }), /POLICY_CHANGED/);
});
test('budget splitting does not consume attempts for undelivered batches', async t => {
  const directory = temp(t), dispatches = [];
  const judge = { directory, supportsDispatch: true, async ask(_, __, input, ___, ____, options) {
    if (input.facts.length > 1) throw Error('JUDGE_BUDGET_EXCEEDED');
    options.onDispatch(); dispatches.push(input.facts[0].id);
    return { facts: input.facts.map(f => ({ ...f, ok: true })) };
  } };
  assert.ok((await reviewItems(reviewArgs(judge))).every(f => f.ok)); assert.deepEqual(dispatches, ['a', 'b']);
  const state = readJson(path.join(directory, fs.readdirSync(directory)[0])); assert.deepEqual(state.attempts, { a: 1, b: 1 });
});
test('truth-only calibration and version relabeling cannot pass the formal gate', () => {
  assert.throws(() => requireCalibration({ machineCalibrationPassed: true, judgeVersion: 'quality-judge-5' }), /Calibration gate/);
  const summary = { results: [], usage: { unknownCalls: 0, reservedUnknownTokens: 0, confirmedTokens: 0, activeMs: 0 } };
  assert.equal(calibrationQualification(summary).qualified, false);
});
