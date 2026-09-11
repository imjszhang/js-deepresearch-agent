import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditRelations, relationAuditDecision, relationAuditInput, RELATION_AUDIT_VERSION } from '../scripts/benchmark/quality/relation-audit.mjs';
import { readJson } from '../scripts/benchmark/quality/schema.mjs';

const fixture = readJson('tests/fixtures/research-quality/relation-boundaries-v7.json');
const relation = (changes = {}) => ({ id: 'r1', proposition: 'Nacre v2 exports JSON.', quote: 'Nacre v2 exports JSON.',
  sourceText: 'Nacre v2 exports JSON. CSV export is unspecified.', proposedRelation: 'full_support',
  source: { id: 'manual-v2', version: 'v2', url: 'https://fixture.invalid/v2' }, ...changes });
const checks = (id, changes = {}) => ({ id, relation: 'full_support', object: 'same', version: 'same', conditions: 'compatible',
  claimTarget: 'property', evidenceTarget: 'property', coexistence: 'can_both_hold', ...changes });
const mockJudge = response => ({ identity: { model: 'controlled-offline-mock' }, calls: [], async ask(purpose, instructions, input, _, maxTokens, options) {
  this.calls.push({ purpose, instructions, input, maxTokens, options });
  return response(input, this.calls.length);
} });
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-relation-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
};

test('independent audit hides proposed judgments and private oracle fields while preserving complete material and source identity', async () => {
  const text = 'Nacre v2 exports JSON.\r\n' + 'Context 🙂 e\u0301 '.repeat(2000) + 'CSV export is unspecified.';
  const a = relation({ sourceText: text, source: { id: 'manual-v2', version: 'v2', expected: 'forbidden-oracle', reasoning: 'forbidden-rationale' }, expected: 'forbidden-oracle' });
  const b = relation({ id: 'r2', sourceText: text, source: { id: 'mirror-v2', version: 'v2' } });
  const input = relationAuditInput([a, b], 'report-hash');
  assert.equal(input.materials.length, 1); assert.equal(input.materials[0].text, text);
  assert.equal(input.relations[0].materialId, input.relations[1].materialId);
  assert.notEqual(input.relations[0].source.id, input.relations[1].source.id);
  for (const privateKey of ['proposedRelation', 'expected', 'reasoning', 'forbidden-oracle', 'forbidden-rationale']) assert.equal(JSON.stringify(input).includes(privateKey), false);
  const judge = mockJudge(input => ({ relations: input.relations.map(item => checks(item.id)) }));
  const result = await auditRelations({ judge, relations: [a], reportHash: 'report-hash' });
  assert.equal(result[0].auditStatus, 'confirmed');
  assert.equal(judge.calls[0].input.materials[0].text, text, 'large context must remain complete even if it needs its own batch');
});

test('an independently different relation stays pending after one semantic audit', async () => {
  const judge = mockJudge(input => ({ relations: input.relations.map(item => checks(item.id, { relation: 'not_addressed' })) }));
  const [result] = await auditRelations({ judge, relations: [relation({ proposedRelation: 'contradiction' })] });
  assert.equal(judge.calls.length, 1); assert.equal(result.auditStatus, 'pending_review');
  assert.equal(result.proposedRelation, 'contradiction'); assert.equal(result.reviewRelation, 'not_addressed');
  assert.equal(result.pendingReason, 'relation_audit_disagreement');
  await auditRelations({ judge, relations: [relation({ proposedRelation: 'contradiction' })] });
  assert.equal(judge.calls.length, 1, 'semantic disagreement is an accepted audit result, never an automatic repair loop');
});

test('matching labels cannot bypass object, version, conditions, target or coexistence checks', () => {
  const baseline = checks('r', { relation: 'contradiction', coexistence: 'cannot_both_hold' });
  assert.equal(relationAuditDecision('contradiction', baseline).auditStatus, 'confirmed');
  for (const change of [{ object: 'different' }, { object: 'uncertain' }, { version: 'different' }, { conditions: 'incompatible' },
    { conditions: 'uncertain' }, { claimTarget: 'document_statement' }, { evidenceTarget: 'uncertain' }, { coexistence: 'can_both_hold' }, { coexistence: 'uncertain' }]) {
    assert.equal(relationAuditDecision('contradiction', { ...baseline, ...change }).auditStatus, 'pending_review');
  }
  assert.equal(relationAuditDecision('full_support', checks('r', { coexistence: 'cannot_both_hold' })).auditStatus, 'pending_review');
});

test('malformed audit siblings alone consume the second structure attempt with typed feedback', async () => {
  const judge = mockJudge((input, call) => {
    if (call === 2) {
      assert.deepEqual(input.relations.map(item => item.id), ['r2']);
      assert.equal(input.repair.codes.r2, 'relation_audit_schema_invalid');
    }
    return { relations: input.relations.map(item => checks(item.id, item.id === 'r2' && call === 1 ? { relation: 'false' } : {})) };
  });
  const results = await auditRelations({ judge, relations: [relation(), relation({ id: 'r2' })] });
  assert.equal(judge.calls.length, 2); assert.equal(judge.calls[0].options.maxAttempts, 1);
  assert.ok(results.every(item => item.auditStatus === 'confirmed'));
});

test('two malformed structures exhaust the component without a third semantic or structure dispatch', async () => {
  const judge = mockJudge(input => ({ relations: input.relations.map(item => ({ id: item.id, relation: 'full_support' })) }));
  const first = await auditRelations({ judge, relations: [relation()] });
  const second = await auditRelations({ judge, relations: [relation()] });
  assert.equal(judge.calls.length, 2); assert.equal(first[0].auditStatus, 'pending_review');
  assert.equal(first[0].pendingReason, 'relation_audit_schema_invalid'); assert.deepEqual(second, first);
});

test('absent complete context and unlocatable quotes stay pending without a model call', async () => {
  const judge = mockJudge(() => { throw new Error('unexpected model dispatch'); });
  const results = await auditRelations({ judge, relations: [relation({ sourceText: undefined }), relation({ id: 'r2', quote: 'invented quote' })] });
  assert.equal(judge.calls.length, 0);
  assert.ok(results.every(item => item.auditStatus === 'pending_review' && item.pendingReason === 'relation_audit_context_missing'));
  await assert.rejects(auditRelations({ judge, relations: [relation(), relation()] }), /audit IDs/);
});

test('component audit checkpoints survive process replacement and input batching without duplicating accepted items', async t => {
  const directory = temporary(t);
  const judge = mockJudge(input => ({ relations: input.relations.map(item => checks(item.id)) })); judge.directory = directory;
  const items = Array.from({ length: 14 }, (_, i) => relation({ id: 'r' + i }));
  const initial = await auditRelations({ judge, reportHash: 'report-A', relations: items });
  assert.deepEqual(judge.calls.map(call => call.input.relations.length), [6, 6, 2]);
  assert.ok(judge.calls.every(call => call.maxTokens <= 4500));
  const restarted = mockJudge(() => { throw new Error('accepted audit must be reused'); }); restarted.directory = directory;
  const resumed = await auditRelations({ judge: restarted, reportHash: 'report-A', relations: [items[13], items[0], items[8]] });
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(resumed, [initial[13], initial[0], initial[8]]);
});

test('changed proposition, complete context, owner, proposal and report identity each require a fresh audit', async () => {
  const judge = mockJudge(input => ({ relations: input.relations.map(item => checks(item.id)) }));
  const base = relation();
  await auditRelations({ judge, relations: [base], reportHash: 'A' });
  for (const changed of [relation({ proposition: 'Nacre v2 supports JSON output.' }),
    relation({ sourceText: base.sourceText + ' Additional unabridged context.' }),
    relation({ source: { ...base.source, id: 'another-manual' } }), relation({ proposedRelation: 'partial_support' })]) {
    await auditRelations({ judge, relations: [changed], reportHash: 'A' });
  }
  await auditRelations({ judge, relations: [base], reportHash: 'B' });
  assert.equal(judge.calls.length, 6);
});

test('14 explicit paired diagnostic cases validate the decision flow with a controlled semantic mock, not model quality', async () => {
  assert.equal(fixture.relationAuditVersion, RELATION_AUDIT_VERSION);
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, 14);
  const pairs = new Map();
  for (const item of fixture.cases) {
    assert.ok(item.sourceText.includes(item.quote));
    pairs.set(item.pairId, (pairs.get(item.pairId) || 0) + 1);
  }
  assert.equal(pairs.size, 7); assert.ok([...pairs.values()].every(count => count === 2));
  const judge = mockJudge(input => {
    assert.equal(JSON.stringify(input).includes('expected'), false);
    assert.equal(JSON.stringify(input).includes('proposedRelation'), false);
    return { relations: input.relations.map(item => {
      const result = { ...fixture.cases.find(original => original.id === item.id).expected }; delete result.auditStatus;
      return { id: item.id, ...result };
    }) };
  });
  const results = await auditRelations({ judge, reportHash: 'diagnostics', relations: fixture.cases });
  for (const result of results) {
    const item = fixture.cases.find(item => item.id === result.id);
    assert.equal(result.auditStatus, item.expected.auditStatus, item.id);
    assert.equal(result.reviewRelation, item.expected.relation, item.id);
  }
});
