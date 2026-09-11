import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceCatalog } from '../scripts/benchmark/quality/locators.mjs';
import { reviewMaterialDecisions, materialDecisionInput, RELATION_DECISION_VERSION } from '../scripts/benchmark/quality/relation-decision.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';

const material = (changes = {}) => {
  const source = { id: 'manual', sourceId: 'source-manual', text: 'Nacre v2 exports JSON. No latency measurements are supplied.',
    version: 'v2', url: 'https://fixture.invalid/nacre/v2', ...changes.source };
  return { id: 'check-1', proposition: 'Nacre v2 exports JSON.', kind: 'fact', source, catalog: evidenceCatalog(source), candidates: [], ...changes,
    ...(changes.source ? { source, catalog: evidenceCatalog(source) } : {}) };
};
const judgeFor = handler => ({ identity: { model: 'offline-decision-mock' }, calls: [],
  async ask(purpose, instructions, input, validate, maxTokens, options) {
    this.calls.push({ purpose, instructions, input, maxTokens, options });
    return handler(purpose, input, this.calls.length);
  } });
const decision = (item, { quote = 'Nacre v2 exports JSON.', relation = 'full_support', basis = 'assertion', coverage = 'complete' } = {}) => ({
  id: item.id, coverage, relations: quote == null ? [] : [{ unitId: item.locator.units[0].id, quote, relation, basis }],
});
const audit = (item, { valid = true, issue = 'none', omissions = 'none', coverage = 'complete' } = {}) => ({
  id: item.id, coverage, anchors: item.decision.anchors.map(anchor => ({ id: anchor.id, valid, issue })), omissions,
});
const goodJudge = () => judgeFor((purpose, input) => ({ checks: input.checks.map(item => purpose.startsWith('audit_') ? audit(item) : decision(item)) }));
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-material-decision-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('a decision can discover direct evidence when no candidate exists and needs a completed independent basis audit', async () => {
  const judge = goodJudge();
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.deepEqual(judge.calls.map(c => c.purpose), ['decide_relations', 'audit_relation_decisions']);
  assert.equal(result.decisionStatus, 'confirmed'); assert.equal(result.semanticRepairCount, 0);
  assert.equal(result.relations[0].evidenceId, 'manual'); assert.match(result.relations[0].anchorId, /^anchor-/);
  assert.deepEqual(result.relations[0].span, [0, 22]);
  assert.equal(result.records.initialAudit.anchors[0].valid, true);
  assert.equal(result.relationDecisionVersion, RELATION_DECISION_VERSION);
  assert.equal('claimTarget' in result.relations[0], false);
});

test('complete empty decisions undergo an omission audit; uncertain empty decisions do not become absence', async () => {
  const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => purpose.startsWith('audit_') ? audit(item) : decision(item, { quote: null })) }));
  const [complete] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material({ proposition: 'Nacre v2 exports CSV.' })] });
  assert.equal(complete.decisionStatus, 'confirmed'); assert.deepEqual(complete.relations, []);
  assert.equal(judge.calls.length, 2); assert.deepEqual(judge.calls[1].input.checks[0].decision.anchors, []);
  const uncertain = judgeFor((_, input) => ({ checks: input.checks.map(item => decision(item, { quote: null, coverage: 'uncertain' })) }));
  const [pending] = await reviewMaterialDecisions({ judge: uncertain, reportHash: 'B', checks: [material()] });
  assert.equal(pending.decisionStatus, 'pending_review'); assert.equal(pending.pendingReason, 'relation_material_coverage_uncertain');
  assert.equal(uncertain.calls.length, 1);
});

test('candidate relation labels and oracle fields never become decision authority', async () => {
  const item = material({ proposition: 'Nacre v2 processes a million requests per second.' });
  item.candidates = [{ quote: 'No latency measurements are supplied.', span: [23, item.source.text.length],
    relation: 'contradiction', expected: 'incorrect', authority: 'first-judge', catalogHash: item.catalog.catalogHash }];
  const judge = judgeFor((purpose, input) => {
    for (const check of input.checks) for (const c of check.candidates) assert.deepEqual(Object.keys(c).sort(), ['id', 'quote', 'range']);
    assert.equal(JSON.stringify(input).includes('first-judge'), false);
    return { checks: input.checks.map(c => purpose.startsWith('audit_') ? audit(c) : decision(c, { quote: null })) };
  });
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [item] });
  assert.equal(result.decisionStatus, 'confirmed'); assert.deepEqual(result.relations, []);
  assert.equal(result.semanticRepairCount, 0);
});

test('a definite predicate error permits one new decision and requires auditing the repaired empty result', async () => {
  const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => {
    if (purpose === 'decide_relations') return decision(item, { quote: 'No latency measurements are supplied.', relation: 'contradiction', basis: 'direct_negation' });
    if (purpose === 'audit_relation_decisions') return audit(item, { valid: false, issue: 'predicate_shift' });
    if (purpose === 'repair_relation_decisions') {
      assert.equal(item.basisReview.anchors[0].issue, 'predicate_shift');
      return decision(item, { quote: null });
    }
    return audit(item);
  }) }));
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material({ proposition: 'Nacre v2 completes requests in one millisecond.' })] });
  assert.deepEqual(judge.calls.map(c => c.purpose), ['decide_relations', 'audit_relation_decisions', 'repair_relation_decisions', 'audit_relation_decisions_final']);
  assert.equal(result.decisionStatus, 'confirmed'); assert.equal(result.semanticRepairCount, 1); assert.deepEqual(result.relations, []);
  assert.equal(result.records.initialDecision.relations[0].relation, 'contradiction');
  assert.equal(result.records.initialAudit.anchors[0].valid, false); assert.equal(result.records.finalAudit.omissions, 'none');
  await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material({ proposition: 'Nacre v2 completes requests in one millisecond.' })] });
  assert.equal(judge.calls.length, 4, 'finished repaired semantics are reused, not reconsidered on resume');
});

test('the independent audit can reject a false empty decision by detecting omitted evidence', async () => {
  const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => {
    if (purpose === 'decide_relations') return decision(item, { quote: null });
    if (purpose === 'audit_relation_decisions') return audit(item, { omissions: 'present' });
    return purpose.startsWith('audit_') ? audit(item) : decision(item);
  }) }));
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.decisionStatus, 'confirmed'); assert.equal(result.semanticRepairCount, 1);
  assert.equal(result.records.initialDecision.relations.length, 0); assert.equal(result.relations.length, 1);
});

for (const uncertain of [{ valid: null, issue: 'uncertain' }, { omissions: 'uncertain' }, { coverage: 'uncertain' }]) {
  test('uncertain basis/coverage/omission remains pending without semantic retries: ' + JSON.stringify(uncertain), async () => {
    const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => purpose.startsWith('audit_') ? audit(item, uncertain) : decision(item)) }));
    const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
    assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.semanticRepairCount, 0); assert.equal(judge.calls.length, 2);
  });
}

test('failure after an unchanged repair remains pending without repeated adjudication or voting', async () => {
  const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => purpose.startsWith('audit_')
    ? audit(item, { valid: false, issue: 'scope_mismatch' }) : decision(item)) }));
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.pendingReason, 'relation_repair_no_progress');
  assert.equal(result.semanticRepairCount, 1); assert.equal(judge.calls.length, 3);
});

test('malformed decision siblings consume only their remaining structural attempt, never a semantic repair', async () => {
  const judge = judgeFor((purpose, input, call) => ({ checks: input.checks.map(item => {
    if (purpose.startsWith('audit_')) return audit(item);
    if (call === 2) { assert.deepEqual(input.checks.map(c => c.id), ['bad']); assert.equal(input.repair.codes.bad, 'relation_decision_basis'); }
    return decision(item, item.id === 'bad' && call === 1 ? { relation: 'contradiction', basis: 'assertion' } : {});
  }) }));
  const result = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material(), material({ id: 'bad' })] });
  assert.ok(result.every(r => r.decisionStatus === 'confirmed' && r.semanticRepairCount === 0));
  assert.deepEqual(judge.calls.map(c => c.purpose), ['decide_relations', 'decide_relations', 'audit_relation_decisions']);
  assert.ok(judge.calls.every(c => c.options.maxAttempts === 1));
});

test('fabricated anchor audits fail exact-ID validation twice and never establish an empty or supported result', async () => {
  const judge = judgeFor((purpose, input) => ({ checks: input.checks.map(item => purpose.startsWith('audit_')
    ? { ...audit(item), anchors: [{ id: 'fabricated', valid: true, issue: 'none' }] } : decision(item)) }));
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.pendingReason, 'relation_basis_anchor_ids');
  assert.equal(judge.calls.length, 3); assert.equal(result.semanticRepairCount, 0);
});

test('full bodies are sent once per batch with separate source identities and no truncation', () => {
  const text = 'α🙂\r\n' + 'complete context '.repeat(2000);
  const a = material({ id: 'a', source: { id: 'source-a', text } }), b = material({ id: 'b', source: { id: 'source-b', text } });
  const input = materialDecisionInput([a, b]);
  assert.equal(input.bodies.length, 1); assert.equal(input.bodies[0].text, text);
  assert.notEqual(input.checks[0].source.id, input.checks[1].source.id);
  assert.notEqual(input.checks[0].locator.catalogHash, input.checks[1].locator.catalogHash);
});

test('component decisions and basis audits survive process replacement and different batch boundaries', async t => {
  const directory = temp(t), judge = goodJudge(); judge.directory = directory;
  const checks = Array.from({ length: 7 }, (_, i) => material({ id: 'check-' + i }));
  const original = await reviewMaterialDecisions({ judge, reportHash: 'A', checks });
  assert.equal(judge.calls.length, 4);
  const resumedJudge = judgeFor(() => { throw Error('unexpected dispatch'); }); resumedJudge.directory = directory;
  const resumed = await reviewMaterialDecisions({ judge: resumedJudge, reportHash: 'A', checks: [checks[6], checks[0], checks[4]] });
  assert.equal(resumedJudge.calls.length, 0); assert.deepEqual(resumed, [original[6], original[0], original[4]]);
});

test('changed candidates, body, proposition and report identity invalidate dependent decisions', async () => {
  const judge = goodJudge(), base = material();
  await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [base] });
  for (const check of [material({ candidates: [{ quote: 'Nacre v2 exports JSON.', span: [0, 22] }] }),
    material({ source: { text: base.source.text + ' Additional context.' } }), material({ proposition: 'JSON export is available in Nacre v2.' })]) {
    await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [check] });
  }
  await reviewMaterialDecisions({ judge, reportHash: 'B', checks: [base] });
  assert.equal(judge.calls.length, 10);
});

test('provider uncertainty during the final basis audit cannot publish a repaired decision', async () => {
  const judge = judgeFor((purpose, input) => {
    if (purpose === 'audit_relation_decisions_final') throw Error('JUDGE_PROVIDER_FAILED');
    return { checks: input.checks.map(item => purpose === 'audit_relation_decisions' ? audit(item, { omissions: 'present' })
      : decision(item, purpose === 'decide_relations' ? { quote: null } : {})) };
  });
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.pendingReason, 'provider_pending');
  assert.equal(result.records.repairDecision.relations.length, 1); assert.equal(result.records.finalAudit.pendingReason, 'provider_pending');
  assert.equal(judge.calls.length, 4);
});

for (const variant of ['identical', 'reordered', 'unit-alias', 'repartitioned']) {
  test('[V04] unchanged normalized evidence cannot obtain a later agreeing audit: ' + variant, async () => {
    const item = material({ source: { text: 'Alpha beta.\nGamma delta.' } });
    const initialQuotes = variant === 'reordered' ? ['Alpha beta.', 'Gamma delta.'] : ['Alpha beta.'];
    const judge = judgeFor((purpose, input) => {
      assert.notEqual(purpose, 'audit_relation_decisions_final', 'unchanged decision must not be audited again');
      return { checks: input.checks.map(check => {
        if (purpose === 'audit_relation_decisions') return audit(check, { valid: false, issue: 'insufficient_basis' });
        const quotes = purpose === 'decide_relations' ? initialQuotes : variant === 'reordered' ? [...initialQuotes].reverse()
          : variant === 'repartitioned' ? ['Alpha ', 'beta.'] : initialQuotes;
        const unitId = variant === 'unit-alias' && purpose === 'repair_relation_decisions' ? check.locator.units[1].id : check.locator.units[0].id;
        return { id: check.id, coverage: 'complete', relations: quotes.map((quote, index) => ({ unitId, quote,
          id: purpose + '-' + index, anchorId: 'display-only-' + index, relation: 'full_support', basis: 'assertion' })) };
      }) };
    });
    judge.assessmentOrigin = 'scripted_fixture';
    const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [item] });
    assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.pendingReason, 'relation_repair_no_progress');
    assert.equal(result.repairProgress.status, 'completed_no_change');
    assert.equal(result.repairProgress.initialFingerprint, result.repairProgress.repairedFingerprint);
    assert.equal(result.records.finalAudit, null); assert.equal(result.records.initialAudit.anchors[0].valid, false);
    assert.equal(result.origin, 'scripted_fixture'); assert.equal(result.repairProgress.origin, 'program_check');
    assert.equal(judge.calls.length, 3);
    await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [item] }); assert.equal(judge.calls.length, 3);
  });
}

for (const repartitioned of [false, true]) test('[V05] changing other evidence cannot erase a retained rejected basis: ' + repartitioned, async () => {
  const item = material({ source: { text: 'Alpha beta.\nGamma delta.\nNew context.' } });
  const judge = judgeFor((purpose, input) => {
    assert.notEqual(purpose, 'audit_relation_decisions_final', 'known retained disagreement prevents another semantic dispatch');
    return { checks: input.checks.map(check => {
      if (purpose === 'audit_relation_decisions') return { ...audit(check), anchors: check.decision.anchors.map((anchor, index) => ({
        id: anchor.id, valid: index !== 0, issue: index === 0 ? 'insufficient_basis' : 'none' })) };
      const quotes = purpose === 'decide_relations' ? ['Alpha beta.', 'Gamma delta.']
        : [...(repartitioned ? ['Alpha ', 'beta.'] : ['Alpha beta.']), 'New context.'];
      return { id: check.id, coverage: 'complete', relations: quotes.map(quote => ({ unitId: check.locator.units[0].id, quote, relation: 'full_support', basis: 'assertion' })) };
    }) };
  });
  judge.assessmentOrigin = 'scripted_fixture';
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [item] });
  assert.equal(result.decisionStatus, 'pending_review'); assert.equal(result.pendingReason, 'relation_repair_retained_disagreement');
  assert.notEqual(result.repairProgress.initialFingerprint, result.repairProgress.repairedFingerprint);
  assert.equal(result.repairProgress.retainedRejectedFingerprints.length, 1); assert.equal(result.records.finalAudit, null);
  assert.equal(result.records.initialAudit.anchors[0].valid, false); assert.equal(judge.calls.length, 3);
});

for (const secondRejected of [true, false]) test('[V05] combining only previously selected ranges preserves each original disagreement: ' + secondRejected, async () => {
  const item = material({ source: { text: 'Alpha beta. Old. New.' } });
  const judge = judgeFor((purpose, input) => {
    assert.notEqual(purpose, 'audit_relation_decisions_final');
    return { checks: input.checks.map(check => {
      if (purpose === 'audit_relation_decisions') return { ...audit(check), anchors: check.decision.anchors.map((anchor, index) => ({ id: anchor.id,
        valid: index === 2 || index === 1 && !secondRejected, issue: index === 2 || index === 1 && !secondRejected ? 'none' : 'insufficient_basis' })) };
      const quotes = purpose === 'decide_relations' ? ['Alpha ', 'beta.', 'Old.'] : ['Alpha beta.', 'New.'];
      return { id: check.id, coverage: 'complete', relations: quotes.map(quote => ({ unitId: check.locator.units[0].id, quote, relation: 'full_support', basis: 'assertion' })) };
    }) };
  });
  judge.assessmentOrigin = 'scripted_fixture';
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [item] });
  assert.equal(result.pendingReason, 'relation_repair_retained_disagreement');
  assert.equal(result.repairProgress.retainedRejectedFingerprints.length, secondRejected ? 2 : 1);
  assert.equal(judge.calls.length, 3);
});

test('[V04] repeating a complete empty decision cannot clear a prior omission observation', async () => {
  const judge = judgeFor((purpose, input) => {
    assert.notEqual(purpose, 'audit_relation_decisions_final');
    return { checks: input.checks.map(check => purpose === 'audit_relation_decisions' ? audit(check, { omissions: 'present' }) : decision(check, { quote: null })) };
  });
  judge.assessmentOrigin = 'scripted_fixture';
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.pendingReason, 'relation_repair_no_progress'); assert.equal(result.records.initialAudit.omissions, 'present');
  assert.equal(result.records.finalAudit, null); assert.equal(judge.calls.length, 3);
});

test('the production Judge preserves the decision/audit schema, strips free reasoning and reuses completed receipts', async t => {
  const directory = temp(t); let calls = 0;
  const identity = { model: 'offline-provider-mock' };
  const llm = { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    const checks = input.checks.map(item => ({ ...(item.decision ? audit(item) : decision(item)), reasoning: 'PRIVATE_AUDIT_REASONING' }));
    return { text: JSON.stringify({ checks, reasoning: 'PRIVATE_AUDIT_REASONING' }), usage: { totalTokens: 17 } };
  } };
  const judge = new Judge({ llm, directory, identity });
  const [result] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(result.decisionStatus, 'confirmed'); assert.equal(calls, 2); assert.equal(judge.usage().confirmedTokens, 34);
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8').includes('PRIVATE_AUDIT_REASONING'), false);
  }
  const restarted = new Judge({ llm, directory, identity });
  const [resumed] = await reviewMaterialDecisions({ judge: restarted, reportHash: 'A', checks: [material()] });
  assert.deepEqual(resumed, result); assert.equal(calls, 2); assert.equal(restarted.usage().confirmedTokens, 34);
});

test('an unknown audit keeps its reservation and recovers a late receipt without another model dispatch', async t => {
  const directory = temp(t), identity = { model: 'offline-late-receipt-mock' }; let calls = 0, unresolvedInput;
  const llm = { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    if (input.checks[0].decision) { unresolvedInput = input; throw Error('simulated interrupted provider'); }
    return { text: JSON.stringify({ checks: input.checks.map(item => decision(item)) }), usage: { totalTokens: 19 } };
  } };
  const judge = new Judge({ llm, directory, identity });
  const [pending] = await reviewMaterialDecisions({ judge, reportHash: 'A', checks: [material()] });
  assert.equal(pending.decisionStatus, 'pending_review'); assert.equal(pending.pendingReason, 'provider_pending');
  assert.equal(judge.usage().unknownCalls, 1); assert.ok(judge.usage().reservedUnknownTokens > 0);
  const ledger = readJson(path.join(directory, 'ledger.json'));
  const [callId] = Object.entries(ledger.calls).find(([, entry]) => entry.tokens == null);
  const text = JSON.stringify({ checks: unresolvedInput.checks.map(item => audit(item)) });
  writeJson(path.join(directory, callId + '.json'), { text, outputHash: hash(text), usage: { totalTokens: 13 }, activeMs: 1 });
  const restarted = new Judge({ llm, directory, identity });
  const [resolved] = await reviewMaterialDecisions({ judge: restarted, reportHash: 'A', checks: [material()] });
  assert.equal(resolved.decisionStatus, 'confirmed'); assert.equal(calls, 2);
  assert.equal(restarted.usage().unknownCalls, 0); assert.equal(restarted.usage().reservedUnknownTokens, 0);
  assert.equal(restarted.usage().confirmedTokens, 32);
});
