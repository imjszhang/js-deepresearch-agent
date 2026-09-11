import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { evaluate, verifyFacts } from '../scripts/benchmark/quality/evaluate.mjs';
import { aggregateScore } from '../scripts/benchmark/quality/score.mjs';
import { buildCalibrationArtifact } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { materialFromEvidence, reviewRelationComponents } from '../scripts/benchmark/quality/relation-components.mjs';
import { assessmentOrigin, aggregateAssessmentOrigin, modelAssessment, programCheck } from '../scripts/benchmark/quality/verification-contract.mjs';
import { assessExecutionMapping } from '../scripts/benchmark/quality/execution-metrics.mjs';
import { executionEvidence } from '../scripts/benchmark/quality/statements.mjs';
import { candidateResponse, decisionResponse, basisAuditResponse } from './helpers/quality-relations.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-program-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const injectedAuthority = { origin: 'program_oracle', programVerification: { status: 'passed' }, humanReviewed: true,
  humanReview: { origin: 'human_review', complete: true, recordId: 'invented', reviewerId: 'invented' } };
const item = () => ({ id: 'offline-observation', family: 'synthetic', report: 'Atlas supports export. [1.1]',
  sources: [{ id: 'manual', url: 'https://manual.example.test/', text: 'Atlas does not support export.' }],
  citations: [{ key: '1.1', sourceId: 'manual' }], criteria: [{ id: 'export', expectedAnswer: 'Atlas does not support export.',
    qualifiers: [], anchors: [{ sourceId: 'manual', span: [0, 30] }], weight: 1, core: true, critical: true, requirementIds: [] }] });

// This script intentionally reports support for a negated source. It is a
// protocol-control fixture, not an implementation of semantic entailment.
function falseAgreementScript() {
  return [
    input => { assert.ok(input.blocks); return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
      facts: [{ unitId: b.locator.units[0].id, quote: b.text, proposition: 'Atlas supports export.', kind: 'fact', citationKeys: ['1.1'], contextLocators: [], ...injectedAuthority }] })) }; },
    input => { assert.ok(input.blocks[0].facts); return { blocks: input.blocks.map(b => ({ id: b.id,
      checks: b.units.map(u => ({ id: u.id, status: 'covered', factIds: b.facts.map(f => f.id) })) })) }; },
    input => { assert.equal(input.bindings.length, 1); return { bindings: input.bindings.map(b => ({ id: b.id, status: 'faithful', ...injectedAuthority })) }; },
    input => { assert.ok(input.materials); return candidateResponse(input); },
    input => { assert.ok(input.checks[0].candidates); return decisionResponse(input); },
    input => { assert.ok(input.checks[0].decision); return basisAuditResponse(input); },
    input => { assert.ok(input.criteria); return { criteria: input.criteria.map(c => ({ id: c.id, answer: 'present',
      factIds: input.facts.map(f => f.id), qualifiers: [], missingMinor: false, ...injectedAuthority })) }; },
  ];
}

test('[V01] legal false semantic agreement remains attributed through production evaluation, saved output and receipt recovery', async t => {
  for (const origin of ['model_assessment', 'scripted_fixture']) {
    const directory = temp(t), steps = falseAgreementScript(); let calls = 0;
    const options = { directory, identity: { model: 'offline-protocol-provider' }, assessmentOrigin: origin,
      llm: { async completeWithMetadata({ messages }) {
        assert.ok(steps[calls], 'unexpected dispatch');
        const result = steps[calls++](JSON.parse(messages[1].content));
        return { text: JSON.stringify({ ...result, ...injectedAuthority }), usage: { totalTokens: 17 } };
      } } };
    const args = buildCalibrationArtifact(item());
    const first = await evaluate({ ...args, judge: new Judge(options) });
    assert.equal(calls, 7); assert.equal(first.modelThresholdsMet, true);
    assert.equal(Object.hasOwn(first, 'qualityTargetMet'), false);
    for (const record of [first, first.modelAssessment, first.metrics, ...first.facts, ...first.bindings,
      ...first.rows, ...first.judgments.facts, ...first.judgments.criteria]) assert.equal(record.origin, origin);
    const fact = first.facts[0];
    assert.equal(fact.bindingIntegrity.origin, 'program_check'); assert.equal(fact.bindingIntegrity.status, 'passed');
    assert.equal(fact.bindingAssessment.origin, origin); assert.equal(fact.occurrenceCitations[0].bindingAssessment.origin, origin);
    assert.equal(first.judgments.facts[0].truth, 'correct');
    assert.equal(first.judgments.facts[0].citations[0].origin, origin);
    for (const check of first.judgments.facts[0].components.truth.checks) {
      assert.equal(check.origin, origin); assert.equal(check.decision.origin, origin);
      assert.equal(check.relations[0].origin, origin);
    }
    assert.equal(first.reviewStatus, 'machine_draft'); assert.equal(first.humanReview.complete, false);
    assert.equal(JSON.stringify(first).includes('program_oracle'), false);
    assert.equal(JSON.stringify(first).includes('invented'), false);
    const output = path.join(directory, 'observation-output.json'); fs.writeFileSync(output, JSON.stringify(first));
    assert.equal(JSON.parse(fs.readFileSync(output)).origin, origin);
    const resumed = await evaluate({ ...args, judge: new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('receipt replay must not dispatch'); } } }) });
    assert.deepEqual(resumed, first); assert.equal(resumed.judgeUsage.confirmedTokens, 119);
    assert.throws(() => new Judge({ ...options, assessmentOrigin: origin === 'scripted_fixture' ? 'model_assessment' : 'scripted_fixture' }), /POLICY_CHANGED/);
  }
});

test('[V01] response authority cannot construct program or human proof and aggregation preserves fixture dependency', () => {
  const assessment = modelAssessment({ status: 'faithful', ...injectedAuthority, nested: injectedAuthority });
  assert.equal(assessment.origin, 'model_assessment'); assert.deepEqual(assessment.nested, {});
  assert.equal(assessmentOrigin({ origin: 'scripted_fixture' }), 'model_assessment');
  assert.equal(aggregateAssessmentOrigin([{ origin: 'program_check' }, { origin: 'scripted_fixture' }]), 'scripted_fixture');
  assert.equal(programCheck({ exactRange: true, unknownCoverage: null }).status, 'incomplete');
  assert.throws(() => programCheck({ semanticLabel: 'faithful' }), /predicates/);
});

test('[V10] known candidate structure failure falls back to full material while unknown, budget and corrupted material cannot', async t => {
  const material = materialFromEvidence({ id: 'source', text: 'No measurements were recorded.', sourceId: 'source', version: 'v1' });
  const args = { reportHash: 'synthetic-report', tasks: [{ id: 'truth:f', proposition: 'There are measurements.', kind: 'fact', materialIds: [material.id] }], materials: [material] };
  let calls = 0;
  const steps = [() => ({ checks: [] }), () => ({ checks: [] }), input => {
    assert.equal(input.bodies[0].text, material.source.text); assert.deepEqual(input.checks[0].candidates, []);
    return decisionResponse(input, () => 'not_addressed');
  }, input => basisAuditResponse(input)];
  const judge = new Judge({ directory: temp(t), identity: {}, assessmentOrigin: 'scripted_fixture', llm: { async completeWithMetadata({ messages }) {
    assert.ok(steps[calls]); return { text: JSON.stringify(steps[calls++](JSON.parse(messages[1].content))), usage: { totalTokens: 0 } };
  } } });
  const [result] = await reviewRelationComponents({ ...args, judge });
  assert.equal(calls, 4); assert.equal(result.truth, 'unverifiable');
  assert.equal(result.checks[0].discovery.fallback, 'full_material'); assert.ok(result.checks[0].discovery.pendingReason);
  assert.equal(result.checks[0].pendingReason, undefined);
  for (const failure of ['unknown', 'budget', 'corrupt']) {
    let attempts = 0;
    const paused = new Judge({ directory: temp(t), identity: {}, limit: failure === 'budget' ? 1 : 100000,
      llm: { async completeWithMetadata() { attempts++; return { text: '{"checks":[]}', usage: null }; } } });
    if (failure === 'corrupt') {
      await assert.rejects(reviewRelationComponents({ ...args, judge: paused, materials: [{ ...material, source: { ...material.source, text: 'Changed body.' } }] }), /INTEGRITY/);
      assert.equal(attempts, 0); continue;
    }
    const [row] = await reviewRelationComponents({ ...args, judge: paused });
    assert.equal(row.truth, 'pending_review'); assert.equal(row.checks[0].discovery.fallback, undefined);
    assert.equal(row.pendingReason, failure === 'budget' ? 'budget_pending' : 'provider_pending');
    assert.equal(attempts, failure === 'budget' ? 0 : 1);
  }
});

test('[V11] a pending occurrence keeps its denominator while an identical eligible occurrence continues independently', async () => {
  const args = buildCalibrationArtifact(item()), purposes = [];
  const facts = [{ id: 'canonical', proposition: 'Atlas supports export.', kind: 'fact', citationKeys: ['1.1'], bindingComplete: false,
    span: [0, 22], occurrences: [[0, 22], [30, 52]], occurrenceCitations: [
      { extractionFactId: 'blocked', span: [0, 22], citationKeys: ['1.1'], bindingComplete: false,
        bindingAssessment: { status: 'missing_context', pendingReason: 'semantic_binding_missing_context' } },
      { extractionFactId: 'ready', span: [30, 52], citationKeys: ['1.1'], bindingComplete: true,
        bindingAssessment: { status: 'faithful', pendingReason: null } },
    ] }];
  const judge = { assessmentOrigin: 'scripted_fixture', async ask(purpose, _, input) {
    purposes.push(purpose); assert.equal(JSON.stringify(input).includes('blocked'), false);
    if (purpose === 'find_evidence') return candidateResponse(input);
    if (purpose === 'decide_relations') return decisionResponse(input);
    assert.equal(purpose, 'audit_relation_decisions'); return basisAuditResponse(input);
  } };
  const judgments = await verifyFacts({ ...args, facts, judge });
  assert.deepEqual(purposes, ['find_evidence', 'decide_relations', 'audit_relation_decisions']);
  assert.equal(judgments.length, 1); assert.equal(judgments[0].truth, 'pending_review');
  assert.deepEqual(judgments[0].occurrenceJudgments.map(j => j.truth), ['pending_review', 'correct']);
  assert.equal(judgments[0].occurrenceJudgments[0].downstreamStatus, 'skipped_binding');
  const score = aggregateScore({ gold: args.gold, facts, extractionComplete: false, judgments: { facts: judgments,
    criteria: [{ id: 'export', verdict: 'correct', factIds: ['canonical'], conflict: 'not_applicable' }] } });
  assert.equal(score.metrics.statementCount, 1); assert.equal(score.metrics.occurrenceCount, 2);
  assert.equal(score.metrics.pendingOccurrenceCount, 1); assert.equal(score.metrics.strictFactAccuracy, null);
  assert.equal(score.modelThresholdsMet, false); assert.equal(score.origin, 'scripted_fixture');
  const incomplete = globalThis.structuredClone(facts);
  delete incomplete[0].occurrenceCitations[1].bindingComplete;
  delete incomplete[0].occurrenceCitations[1].bindingAssessment;
  const blocked = await verifyFacts({ ...args, facts: incomplete, judge: { ask() { assert.fail('missing per-occurrence state cannot override a pending fact'); } } });
  assert.equal(blocked[0].occurrenceJudgments.filter(o => o.truth === 'pending_review').length, 2);
  incomplete[0].occurrenceCitations[1].extractionFactId = 'blocked';
  await assert.rejects(verifyFacts({ ...args, facts: incomplete, judge }), /Duplicate verification occurrence IDs/);
});

test('[V11] complete raw binding integrity with a pending model assessment skips truth and criteria calls in evaluate', async t => {
  const steps = falseAgreementScript().slice(0, 2); let calls = 0;
  steps.push(input => ({ bindings: input.bindings.map(b => ({ id: b.id, status: 'uncertain' })) }));
  const judge = new Judge({ directory: temp(t), identity: {}, assessmentOrigin: 'scripted_fixture', llm: { async completeWithMetadata({ messages }) {
    assert.ok(steps[calls], 'pending bindings must not trigger downstream semantic calls');
    return { text: JSON.stringify(steps[calls++](JSON.parse(messages[1].content))), usage: { totalTokens: 3 } };
  } } });
  const result = await evaluate({ ...buildCalibrationArtifact(item()), judge });
  assert.equal(calls, 3); assert.equal(result.bindingIntegrity.status, 'passed');
  assert.equal(result.bindingAssessment.complete, false); assert.equal(result.facts.length, 1);
  assert.equal(result.judgments.facts[0].downstreamStatus, 'skipped_binding');
  assert.equal(result.judgments.criteria[0].verdict, 'pending_review');
  assert.equal(result.rows.length, 1); assert.equal(result.metrics.occurrenceCount, 1);
  assert.equal(result.modelThresholdsMet, false);
});

test('[V11] criteria receive the eligible occurrence own quote and context instead of a pending duplicate first occurrence', async () => {
  const sample = item(), first = 'Atlas exports files. [1.1]', second = 'Atlas provides file export. [1.1]';
  sample.report = `${first}\n${second}`;
  const purposes = []; let bindingCalls = 0;
  const judge = { assessmentOrigin: 'scripted_fixture', usage: () => ({ calls: purposes.length }), async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: [first, second].map(quote => ({
      quote, unitId: b.locator.units[0].id, proposition: 'Atlas supports export.', kind: 'fact', contextLocators: [], citationKeys: ['1.1'],
    })) })) };
    if (purpose === 'audit_extraction') return { blocks: input.blocks.map(b => ({ id: b.id,
      checks: b.units.map((u, i) => ({ id: u.id, status: 'covered', factIds: [b.facts[i].id] })) })) };
    if (purpose === 'audit_bindings') return { bindings: input.bindings.map(b => ({ id: b.id, status: ++bindingCalls === 1 ? 'uncertain' : 'faithful' })) };
    if (purpose === 'find_evidence') return candidateResponse(input);
    if (purpose === 'decide_relations') return decisionResponse(input);
    if (purpose === 'audit_relation_decisions') return basisAuditResponse(input);
    assert.equal(purpose, 'match_criteria'); assert.equal(input.facts.length, 1);
    assert.equal(input.facts[0].quote, second);
    assert.deepEqual(input.facts[0].span, [first.length + 1, sample.report.length]);
    return { criteria: [{ id: 'export', answer: 'present', factIds: [input.facts[0].id], qualifiers: [], missingMinor: false }] };
  } };
  const result = await evaluate({ ...buildCalibrationArtifact(sample), judge });
  assert.deepEqual(result.facts[0].occurrenceCitations.map(o => o.quote), [first, second]);
  assert.deepEqual(result.facts[0].occurrenceCitations.map(o => o.contextLocators), [[], []]);
  assert.equal(result.metrics.occurrenceCount, 2); assert.equal(result.metrics.pendingOccurrenceCount, 1);
  assert.equal(purposes.filter(p => p === 'match_criteria').length, 1);
});

test('[V10] discarded candidate diagnostics cannot mask a later full material decision pending reason', async t => {
  const material = materialFromEvidence({ id: 'source', sourceId: 'source', text: 'A bounded source body.' }); let calls = 0;
  const judge = new Judge({ directory: temp(t), identity: {}, llm: { async completeWithMetadata({ messages }) {
    const input = JSON.parse(messages[1].content); calls++;
    return { text: JSON.stringify(calls <= 2 ? { checks: [] } : decisionResponse(input, () => 'uncertain')), usage: { totalTokens: 1 } };
  } } });
  const [result] = await reviewRelationComponents({ judge, reportHash: 'report', materials: [material],
    tasks: [{ id: 'truth:f', proposition: 'A proposition.', kind: 'fact', materialIds: [material.id] }] });
  assert.equal(calls, 3); assert.equal(result.checks[0].discovery.pendingReason, 'id_set_invalid');
  assert.equal(result.pendingReason, 'relation_material_coverage_uncertain');
});

test('[V14] fixed judgment arithmetic follows an independent weighted formula without semantic proof or false observations', () => {
  const verdicts = ['correct', 'partial', 'incorrect', 'pending_review'];
  const facts = verdicts.map((_, i) => ({ id: `f${i}`, kind: 'fact', citationKeys: ['1.1'], origin: 'scripted_fixture' }));
  const gold = { criteria: verdicts.map((_, i) => ({ id: `c${i}`, weight: i + 1, core: true, critical: false, partialCredit: true })) };
  const judgments = { facts: verdicts.map((truth, i) => ({ id: `f${i}`, truth, majorError: false, origin: 'scripted_fixture',
    citations: [{ key: '1.1', verdict: i < 2 ? 'supported' : 'unsupported' }] })),
  criteria: verdicts.map((verdict, i) => ({ id: `c${i}`, verdict, factIds: [`f${i}`], conflict: 'not_applicable' })) };
  const result = aggregateScore({ gold, facts, judgments });
  assert.equal(result.metrics.correctCoverage, (1 * 1 + 2 * 0.5 + 3 * 0 + 4 * 0) / 10);
  assert.equal(result.metrics.coverageUpperBound, (1 + 1 + 4) / 10);
  assert.equal(result.metrics.strictFactAccuracy, 1 / 4); assert.equal(result.metrics.citationSupportRate, 2 / 4);
  assert.equal(result.rows.length, 4); assert.ok(result.rows.every(row => row.origin === 'scripted_fixture'));
  const empty = aggregateScore({ gold: { criteria: [] }, facts: [], judgments: { facts: [], criteria: [] }, modelObserved: false });
  assert.equal(empty.metrics.strictFactAccuracy, null); assert.equal(empty.metrics.correctCoverage, null);
  assert.equal(empty.modelThresholdsMet, null); assert.equal(empty.qualityTargetMet, undefined);
});

test('[V14] an unobserved empty report keeps model thresholds null without creating a provider call', async () => {
  const empty = item(); empty.report = '';
  const result = await evaluate({ ...buildCalibrationArtifact(empty), judge: { assessmentOrigin: 'scripted_fixture',
    usage: () => ({ calls: 0 }), ask() { assert.fail('no model input to observe'); } } });
  assert.equal(result.modelThresholdsMet, null); assert.equal(result.modelAssessment.observed, false);
  assert.equal(result.metrics.strictFactAccuracy, null); assert.equal(result.judgeUsage.calls, 0);
});

test('[V15] deterministic value comparison retains semantic mapping origin, missing success counts and known zero', () => {
  const fields = executionEvidence({ result: { quality: { budget: { usage: { sourceReads: 0 } } } },
    store: { versions: new Map(), passages: new Map() } }, {});
  const check = (field, assertedValue = 0) => assessExecutionMapping({ id: 'metric', mapping: 'exact', fieldId: `E-observations.${field}`, assertedValue,
    ...injectedAuthority }, fields, 'scripted_fixture');
  const zero = check('sourceReads'); assert.equal(zero.truth, 'correct'); assert.equal(zero.origin, 'scripted_fixture');
  assert.equal(zero.comparison.origin, 'program_check'); assert.equal(zero.comparison.equal, true);
  const missing = check('successfulBodyReads'); assert.equal(missing.truth, 'unverifiable'); assert.equal(missing.comparison.equal, null);
  const equalDifferentMetric = check('documentVersions'); assert.equal(equalDifferentMetric.truth, 'correct');
  assert.notEqual(equalDifferentMetric.comparison.fieldId, zero.comparison.fieldId);
  assert.equal(equalDifferentMetric.origin, 'scripted_fixture');
  fields.find(f => f.field === 'sourceReads').state = 'unknown';
  assert.equal(check('sourceReads').truth, 'pending_review'); assert.equal(check('sourceReads').comparison.equal, null);
  assert.equal(check('documentVersions').humanReviewed, undefined);
});
