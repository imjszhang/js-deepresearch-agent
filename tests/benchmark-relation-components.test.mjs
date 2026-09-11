import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentInput, deriveCitation, materialFromEvidence, reviewRelationComponents } from '../scripts/benchmark/quality/relation-components.mjs';
import { verifyFacts } from '../scripts/benchmark/quality/evaluate.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { candidateResponse, decisionResponse, basisAuditResponse } from './helpers/quality-relations.mjs';

const temp = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-relation-components-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
const material = (id, text, version = 'v1') => materialFromEvidence({ id, text, sourceId: id, version, span: [10, 10 + text.length] });
const task = (id, materials) => ({ id, proposition: 'The system permits only one writer.', kind: 'fact', materialIds: materials.map(m => m.id) });
function protocolResponse(purpose, input, decide = () => 'full_support') {
  if (purpose === 'find_evidence') return candidateResponse(input);
  if (purpose.startsWith('audit_relation_decisions')) return basisAuditResponse(input);
  assert.ok(['decide_relations', 'repair_relation_decisions'].includes(purpose));
  return decisionResponse(input, check => decide(input.bodies.find(b => b.id === check.bodyId).text, check));
}

test('deduplicated bodies preserve each source and version owner and complete requested scope', () => {
  const sources = [material('manual-a', 'One writer.', 'v1'), material('manual-b', 'One writer.', 'v2')];
  const input = componentInput([task('truth:f', sources)], sources);
  assert.equal(input.bodies.length, 1); assert.equal(input.materials.length, 2);
  assert.equal(new Set(input.materials.map(m => m.locator.owner.evidenceId)).size, 2);
  assert.deepEqual(input.materials.map(m => m.locator.owner.version), ['v1', 'v2']);
  assert.equal(new Set(input.materials.map(m => m.locator.catalogHash)).size, 2);
  assert.deepEqual(input.reviews[0].materialIds, sources.map(m => m.id));
});

test('a missing material check cannot hide unexamined possible counterevidence', async () => {
  const sources = [material('support', 'One writer.'), material('counter', 'Two writers.')]; let calls = 0;
  const judge = { async ask(purpose, _, input) {
    calls++;
    if (purpose === 'find_evidence') return candidateResponse(input);
    assert.equal(purpose, 'decide_relations');
    const response = decisionResponse(input); response.checks.pop(); return response;
  } };
  const [result] = await reviewRelationComponents({ judge, reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources });
  assert.equal(result.truth, 'pending_review'); assert.equal(result.pendingReason, 'id_set_invalid'); assert.equal(calls, 3);
  assert.equal(result.coverageComplete, false);
});

test('empty candidates still require complete material decision and omission audit before absence becomes unverifiable', async () => {
  const sources = [material('manual', 'No measurements have been made.')];
  for (const status of ['not_addressed', 'uncertain']) {
    const purposes = [];
    const judge = { async ask(purpose, _, input) {
      purposes.push(purpose);
      if (purpose === 'find_evidence') return candidateResponse(input, () => false);
      if (purpose === 'decide_relations') { assert.ok(input.checks.every(c => c.candidates.length === 0)); return decisionResponse(input, () => status); }
      assert.equal(purpose, 'audit_relation_decisions'); assert.ok(input.checks.every(c => c.decision.anchors.length === 0));
      return basisAuditResponse(input);
    } };
    const [result] = await reviewRelationComponents({ judge, reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources });
    assert.equal(result.truth, status === 'not_addressed' ? 'unverifiable' : 'pending_review');
    assert.deepEqual(purposes, status === 'not_addressed' ? ['find_evidence', 'decide_relations', 'audit_relation_decisions'] : ['find_evidence', 'decide_relations']);
  }
});

test('confirmed opposing evidence remains a conflict and is retained in a pending citation', async () => {
  const sources = [material('support', 'One writer only is permitted.'), material('counter', 'Two simultaneous writers are permitted.')];
  const decide = text => text.startsWith('One') ? 'full_support' : 'contradiction'; let calls = 0;
  const judge = { async ask(purpose, _, input) { calls++; return protocolResponse(purpose, input, decide); } };
  const [result] = await reviewRelationComponents({ judge, reportHash: 'r', tasks: [task('citation:f:1.1', sources)], materials: sources });
  assert.equal(result.truth, 'pending_review'); assert.equal(result.pendingReason, 'conflicting_evidence'); assert.equal(calls, 3);
  assert.deepEqual(new Set(result.evidence.map(e => e.relation)), new Set(['full_support', 'contradiction']));
  const citation = deriveCitation(result, true); assert.equal(citation.verdict, 'pending_review'); assert.equal(citation.evidence.length, 2);
});

test('unexamined scope preserves confirmed counterevidence while keeping the overall result pending', async () => {
  const sources = [material('uncertain', 'An incomplete context.'), material('counter', 'Two simultaneous writers are permitted.')];
  const decide = text => text.startsWith('Two') ? 'contradiction' : 'uncertain'; let calls = 0;
  const judge = { async ask(purpose, _, input) { calls++; return protocolResponse(purpose, input, decide); } };
  const params = { judge, reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources };
  const [result] = await reviewRelationComponents(params);
  assert.equal(result.truth, 'pending_review'); assert.equal(result.coverageComplete, false);
  assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].relation, 'contradiction');
  assert.equal(result.checks.find(c => c.evidenceId === 'counter').decisionStatus, 'confirmed');
  assert.equal(result.checks.find(c => c.evidenceId === 'counter').decision.records.initialAudit.anchors[0].valid, true);
  assert.equal(calls, 3); await reviewRelationComponents(params); assert.equal(calls, 3);
});

test('a semantic uncertainty cannot mask another material budget or provider pause in the same task', async () => {
  for (const reason of ['budget_pending', 'provider_pending']) {
    const sources = [material('uncertain', 'An incomplete context.'), material('other', 'One writer only is permitted.')];
    let dispatched = 0;
    const judge = { supportsDispatch: true, async ask(purpose, _, input, _validate, _maxTokens, options) {
      if (purpose === 'audit_relation_decisions') {
        if (reason === 'provider_pending') { options.onDispatch(); dispatched++; }
        throw Error(reason === 'budget_pending' ? 'JUDGE_STAGE_BUDGET_EXCEEDED' : 'JUDGE_PROVIDER_FAILED');
      }
      options.onDispatch(); dispatched++;
      return protocolResponse(purpose, input, text => text.startsWith('An incomplete') ? 'uncertain' : 'full_support');
    } };
    const [result] = await reviewRelationComponents({ judge, reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources });
    assert.equal(result.checks[0].pendingReason, 'relation_material_coverage_uncertain');
    assert.equal(result.checks[1].pendingReason, reason);
    assert.equal(result.truth, 'pending_review'); assert.equal(result.pendingReason, reason);
    assert.equal(deriveCitation(result, true).pendingReason, reason);
    assert.equal(dispatched, reason === 'budget_pending' ? 2 : 3);
  }
});

test('definite predicate mistakes permit one audited repair and can never become false through repeated adjudication', async () => {
  const sources = [material('manual', 'No measurements have been made.')];
  for (const repairedRelation of ['not_addressed', 'contradiction']) {
    const purposes = [];
    const judge = { async ask(purpose, _, input) {
      purposes.push(purpose);
      if (purpose === 'find_evidence') return candidateResponse(input);
      if (purpose === 'decide_relations') return decisionResponse(input, () => 'contradiction');
      if (purpose === 'repair_relation_decisions') return decisionResponse(input, () => repairedRelation);
      return basisAuditResponse(input, () => ({ valid: false, issue: 'predicate_shift', omissions: 'none' }));
    } };
    const params = { judge, reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources };
    const [result] = await reviewRelationComponents(params);
    assert.equal(result.truth, repairedRelation === 'not_addressed' ? 'unverifiable' : 'pending_review');
    assert.equal(result.checks[0].decision.semanticRepairCount, 1);
    assert.equal(result.checks[0].decision.records.initialAudit.anchors[0].valid, false);
    const expected = ['find_evidence', 'decide_relations', 'audit_relation_decisions', 'repair_relation_decisions'];
    if (repairedRelation === 'not_addressed') expected.push('audit_relation_decisions_final');
    else assert.equal(result.pendingReason, 'relation_repair_no_progress');
    assert.deepEqual(purposes, expected);
    await reviewRelationComponents(params); assert.equal(purposes.length, expected.length);
  }
});

function technicalArtifact() {
  const text = 'The system permits one writer.', report = text + ' [1.1]';
  const artifact = { report, reportHash: hash(report), result: {}, registry: { entries: [{ citationKey: '1.1', passageIds: ['P1'] }] },
    store: { versions: new Map([['body-v1', { sourceId: 'manual', url: 'https://example.test/manual' }]]),
      passages: new Map([['P1', { id: 'P1', documentVersionId: 'body-v1', text, startChar: 0, endChar: text.length }]]) } };
  const gold = { sources: [{ id: 'manual', version: 'v1', url: 'https://example.test/manual', text }],
    criteria: [{ id: 'c1', expectedAnswer: 'PRIVATE RUBRIC ANSWER', anchors: [{ sourceId: 'manual', span: [0, text.length] }] }] };
  return { artifact, gold, caseDefinition: {}, facts: [{ id: 'f', proposition: text, kind: 'fact', citationKeys: ['1.1'] }] };
}

test('a citation cannot borrow a gold locator, and citation failure preserves independently accepted truth', async t => {
  const params = technicalArtifact(), directory = temp(t), purposes = [];
  let foreignUnit;
  const judge = { directory, async ask(purpose, _, input) {
    purposes.push(purpose); assert.ok(!JSON.stringify(input).includes('PRIVATE RUBRIC ANSWER'));
    if (purpose !== 'find_evidence') return protocolResponse(purpose, input);
    foreignUnit ||= input.materials.find(m => m.locator.owner.evidenceId === 'G1').locator.units[0].id;
    const response = candidateResponse(input);
    for (const row of response.checks) if (input.checks.find(c => c.id === row.id).componentId.startsWith('citation:')) row.candidates[0].unitId = foreignUnit;
    return response;
  } };
  const [first] = await verifyFacts({ ...params, judge });
  assert.equal(first.truth, 'correct'); assert.equal(first.citations[0].verdict, 'pending_review');
  assert.equal(first.citations[0].pendingReason, 'locator_unknown_id'); assert.ok(first.evidence.length > 0);
  const count = purposes.length;
  const [resumed] = await verifyFacts({ ...params, judge }); assert.equal(resumed.truth, 'correct'); assert.equal(purposes.length, count);
});

test('a structurally invalid citation decision does not discard accepted truth decisions or their basis audits', async t => {
  const params = technicalArtifact(), directory = temp(t), citationIds = new Set(), purposes = [];
  let foreignUnit;
  const judge = { directory, async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose === 'find_evidence') {
      for (const c of input.checks) if (c.componentId.startsWith('citation:')) citationIds.add(c.id);
      foreignUnit = input.materials.find(m => m.locator.owner.evidenceId === 'G1').locator.units[0].id;
      return candidateResponse(input);
    }
    if (purpose === 'decide_relations') {
      const response = decisionResponse(input);
      for (const row of response.checks) if (citationIds.has(row.id)) row.relations[0].unitId = foreignUnit;
      return response;
    }
    assert.equal(purpose, 'audit_relation_decisions');
    assert.ok(input.checks.every(c => !citationIds.has(c.id)), 'invalid citation decisions must not reach semantic auditing');
    return basisAuditResponse(input);
  } };
  const [first] = await verifyFacts({ ...params, judge });
  assert.equal(first.truth, 'correct'); assert.equal(first.citations[0].verdict, 'pending_review');
  assert.equal(first.citations[0].pendingReason, 'locator_unknown_id');
  assert.ok(first.components.truth.checks.every(c => c.decisionStatus === 'confirmed'));
  assert.equal(purposes.filter(p => p === 'decide_relations').length, 2);
  const count = purposes.length;
  const [resumed] = await verifyFacts({ ...params, judge });
  assert.equal(resumed.truth, 'correct'); assert.equal(resumed.citations[0].verdict, 'pending_review'); assert.equal(purposes.length, count);
});

test('unknown relation receipts use persisted source dependencies after current material membership changes', async t => {
  const directory = temp(t), sources = [material('manual', 'One writer only is permitted.')], newer = [material('manual', 'Two simultaneous writers are permitted.', 'v2')];
  let calls = 0, originalInput;
  const first = new Judge({ directory, identity: {}, llm: { async completeWithMetadata({ messages }) { calls++; originalInput = JSON.parse(messages[1].content); throw Error('uncertain receipt'); } } });
  const params = { reportHash: 'r', tasks: [task('truth:f', sources)], materials: sources };
  assert.equal((await reviewRelationComponents({ ...params, judge: first }))[0].truth, 'pending_review');
  const id = Object.keys(first.ledger.calls)[0];
  writeJson(path.join(directory, id + '.json'), { text: JSON.stringify(candidateResponse(originalInput)), usage: { totalTokens: 17 }, activeMs: 1 });
  const decide = text => text.startsWith('One') ? 'full_support' : 'contradiction';
  const restored = new Judge({ directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content), response = input.materials ? candidateResponse(input)
      : input.checks[0].decision ? basisAuditResponse(input) : decisionResponse(input, check => decide(input.bodies.find(b => b.id === check.bodyId).text));
    return { text: JSON.stringify(response), usage: { totalTokens: 11 } };
  } } });
  const [newResult] = await reviewRelationComponents({ reportHash: 'r', tasks: [task('truth:f', newer)], materials: newer, judge: restored });
  assert.equal(newResult.truth, 'incorrect');
  const [oldResult] = await reviewRelationComponents({ ...params, judge: restored }); assert.equal(oldResult.truth, 'correct');
  assert.equal(oldResult.evidence[0].owner.version, 'v1'); assert.equal(newResult.evidence[0].owner.version, 'v2');
  assert.equal(restored.usage().unknownCalls, 0); assert.equal(calls, 6); assert.equal(restored.usage().confirmedTokens, 72);
});

test('unknown execution receipts must use their original metric snapshot rather than current values', async t => {
  const directory = temp(t), report = 'The run used three budgeted source reads.';
  const makeArtifact = n => ({ report, reportHash: hash(report), registry: { entries: [] }, store: { versions: new Map(), passages: new Map() },
    result: { quality: { budget: { usage: { sourceReads: n } } } } });
  const params = { gold: { criteria: [], sources: [] }, caseDefinition: {}, facts: [{ id: 'f', kind: 'execution_status', proposition: report, citationKeys: [] }] };
  const response = { reviews: [{ id: 'f', mapping: 'exact', fieldId: 'E-observations.sourceReads', assertedValue: 3 }] };
  let calls = 0;
  const first = new Judge({ directory, identity: {}, llm: { async completeWithMetadata() { calls++; throw Error('uncertain receipt'); } } });
  assert.equal((await verifyFacts({ ...params, artifact: makeArtifact(3), judge: first }))[0].truth, 'pending_review');
  const id = Object.keys(first.ledger.calls)[0]; writeJson(path.join(directory, id + '.json'), { text: JSON.stringify(response), usage: { totalTokens: 17 }, activeMs: 1 });
  const restored = new Judge({ directory, identity: {}, llm: { async completeWithMetadata() { calls++; return { text: JSON.stringify(response), usage: { totalTokens: 11 } }; } } });
  assert.equal((await verifyFacts({ ...params, artifact: makeArtifact(4), judge: restored }))[0].truth, 'incorrect');
  assert.equal((await verifyFacts({ ...params, artifact: makeArtifact(3), judge: restored }))[0].truth, 'correct');
  assert.equal(calls, 2); assert.equal(restored.usage().confirmedTokens, 28);
});
