import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locatorCatalog, locatorInput, resolveLocator, evidenceCatalog } from '../scripts/benchmark/quality/locators.mjs';
import { extractReportFacts, reportBlocks } from '../scripts/benchmark/quality/report-facts.mjs';
import { verifyFacts } from '../scripts/benchmark/quality/evaluate.mjs';
import { operationalTruth, relationTruth } from '../scripts/benchmark/quality/evidence-relations.mjs';
import { executionEvidence } from '../scripts/benchmark/quality/statements.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { freezeVerification, verificationIdentity } from '../scripts/benchmark/quality/calibration-freeze.mjs';
import { evaluatorCodeIdentity, buildCalibrationArtifact } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { candidateResponse, decisionResponse, basisAuditResponse, bindingResponse } from './helpers/quality-relations.mjs';
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-v6-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const rawFact = (b, quote) => ({ unitId: b.locator.units[0].id, quote, proposition: quote, kind: 'fact', citationKeys: [] });
const audit = b => ({ id: b.id, checks: b.units.map(u => ({ id: u.id, status: b.facts.length ? 'covered' : 'non_assertion', factIds: b.facts.map(f => f.id) })) });

for (const text of ['中文全角Ａ，事实。', 'A😀e\u0301\r\nB\t Ｂ', '|版本|条件|\r\n|v1|离线|', '```js\nconst x = "🙂";\n```']) test('raw UTF-16 locator roundtrip ' + hash(text).slice(0, 6), () => {
  const c = locatorCatalog(text, { reportHash: hash(text) }, 17);
  for (const u of c.units) {
    const a = resolveLocator({ unitId: u.id, quote: u.text }, c);
    assert.equal(text.slice(...a.span), u.text); assert.deepEqual(a.originalSpan, a.span.map(n => n + 17));
    assert.equal(a.catalogHash, c.catalogHash);
  }
  assert.deepEqual(locatorInput(c), locatorInput(locatorCatalog(text, c.owner, 17)));
});
test('ambiguous quotes require offered occurrence fragments, never the first index', () => {
  const c = locatorCatalog('same; same; same', { source: 'v1' }); let error;
  try { resolveLocator({ unitId: c.units[0].id, quote: 'same' }, c); } catch (e) { error = e; }
  assert.equal(error.code, 'locator_ambiguous'); assert.equal(error.candidates.length, 3);
  assert.throws(() => resolveLocator({ fragmentId: error.candidates[1].fragmentId }, c), /unknown_id/);
  const a = resolveLocator({ fragmentId: error.candidates[1].fragmentId }, c, error.candidates);
  assert.deepEqual(a.span, [6, 10]);
  const tampered = globalThis.structuredClone(error.candidates); tampered[1].span = [0, 4];
  assert.throws(() => resolveLocator({ fragmentId: tampered[1].fragmentId }, c, tampered), /catalog_mismatch/);
});
test('fabricated IDs, owners, catalogs, normalized quotes and model offsets fail closed', () => {
  const c = locatorCatalog('A\r\nＡ 😀 e\u0301', { version: 'v1' }), selection = { unitId: c.units[0].id, quote: c.units[0].text };
  for (const change of [{ unitId: 'invented' }, { quote: 'A\nＡ 😀 e\u0301' }, { quote: 'A' + '\r\nＡ 😀 é' },
    { owner: { version: 'v2' } }, { catalogHash: 'wrong' }, { span: [0, 1] }, { start: 0 }, { end: 1 }, { quote: '\uD83D' }]) {
    assert.throws(() => resolveLocator({ ...selection, ...change }, c));
  }
  const other = locatorCatalog(c.units[0].text, { version: 'v2' });
  assert.throws(() => resolveLocator(selection, other), /unknown_id/);
});
test('long containers preserve surrogate pairs, trailing text and table context across the former 7000 boundary', async () => {
  const report = '| Version | Condition |\n' + 'a'.repeat(6976) + '😀' + 'x'.repeat(8100) + '\r\n| v1 | offline |';
  const blocks = reportBlocks(report); assert.equal(blocks.length, 1); assert.equal(blocks[0].text, report);
  const c = locatorCatalog(report, { reportHash: hash(report) });
  assert.equal(c.units[0].text, report); assert.equal(c.units.at(-1).text, '| v1 | offline |');
  const whole = resolveLocator({ unitId: c.units[0].id, quote: report }, c);
  assert.deepEqual(whole.span, [0, report.length]);
  const result = await extractReportFacts(report, { async ask() { throw Error('JUDGE_BUDGET_EXCEEDED'); } });
  assert.equal(result.extractionComplete, false); assert.equal(result.extraction[0].pendingReason, 'budget_pending');
});
test('ambiguous sibling retains valid candidates and consumes only the remaining structural attempt', async () => {
  let extracts = 0;
  const report = 'A is true. B repeats. B repeats.';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'audit_bindings') return bindingResponse(input);
    if (purpose !== 'extract') return { blocks: input.blocks.map(audit) };
    extracts++;
    return { blocks: input.blocks.map(b => {
      if (extracts === 1) return { id: b.id, classification: 'content', facts: [rawFact(b, 'A is true.'), rawFact(b, 'B repeats.')] };
      assert.equal(input.repair.codes[b.id], 'locator_ambiguous');
      assert.equal(input.repair.acceptedCandidates[b.id].length, 1);
      const choices = input.repair.candidates[b.id]; assert.equal(choices.length, 2); assert.equal(choices[0].span, undefined);
      return { id: b.id, classification: 'content', facts: choices.map(c => ({ fragmentId: c.fragmentId, proposition: c.quote, kind: 'fact', citationKeys: [] })) };
    }) };
  } });
  assert.equal(extracts, 2); assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 2);
  assert.deepEqual(result.facts[1].occurrences, [[11, 21], [22, 32]]);
});
test('exhausted bad siblings retain valid facts but keep coverage pending', async () => {
  let calls = 0;
  const result = await extractReportFacts('A is true. B is false.', { async ask(purpose, _, input) {
    assert.equal(purpose, 'extract'); calls++;
    return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: calls === 1
      ? [rawFact(b, 'A is true.'), rawFact(b, 'invented')] : [rawFact(b, 'still invented')] })) };
  } });
  assert.equal(calls, 2); assert.equal(result.facts.length, 1); assert.equal(result.extractionComplete, false);
  assert.equal(result.extraction[0].pendingReason, 'locator_quote_not_found');
});
test('shared conditions get independently resolved context spans and cannot be silently dropped by audit', async () => {
  const report = 'Version 1:\nOffline mode is required.';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'audit_bindings') return bindingResponse(input);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: [{ ...rawFact(b, 'Offline mode is required.'),
      proposition: 'Version 1 requires offline mode.', contextLocators: [{ unitId: b.locator.units[0].id, quote: 'Version 1:' }] }] })) };
    return { blocks: input.blocks.map(b => ({ id: b.id, checks: b.units.map((u, i) => ({ id: u.id, status: i === 0 ? 'non_assertion' : 'covered', factIds: i === 0 ? [] : b.facts.map(f => f.id) })) })) };
  } });
  assert.equal(result.extractionComplete, true); assert.deepEqual(result.facts[0].contextSpans, [[0, 10]]);
});
test('faithful locations cannot override audit detecting a rewritten negation', async () => {
  let repair = 0;
  const result = await extractReportFacts('A does not run offline.', { async ask(purpose, _, input) {
    if (purpose === 'extract' || purpose === 'extract_repair') {
      if (purpose === 'extract_repair') { repair++; return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: [] })) }; }
      return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: [{ ...rawFact(b, b.text), proposition: 'A runs offline.' }] })) };
    }
    return { blocks: input.blocks.map(b => ({ id: b.id, checks: b.units.map(u => ({ id: u.id, status: 'missing', factIds: [] })) })) };
  } });
  assert.equal(repair, 1); assert.equal(result.extractionComplete, false);
});
test('gold anchors retain original offsets and same text in another citation cannot borrow support', async () => {
  const item = readJson('tests/fixtures/research-quality/v6/development.json').cases[0], args = buildCalibrationArtifact(item);
  let observations = 0, goldSelection; const componentAttempts = [];
  const result = await verifyFacts({ ...args, facts: [{ id: 'f', proposition: 'One writer is supported.', kind: 'fact', citationKeys: [item.citations[0].key] }], judge: { async ask(purpose, __, input) {
    if (purpose === 'decide_relations') return decisionResponse(input, c => c.source.id === 'G1' ? 'full_support' : null);
    if (purpose === 'audit_relation_decisions') return basisAuditResponse(input);
    assert.equal(purpose, 'find_evidence'); observations++;
    componentAttempts.push(...input.checks.map(r => r.componentId));
    const gold = input.materials.find(m => m.locator.owner.evidenceId === 'G1');
    if (gold) goldSelection = { unitId: gold.locator.units[0].id, quote: input.bodies.find(b => b.id === gold.bodyId).text };
    const response = candidateResponse(input);
    for (const row of response.checks) if (input.checks.find(c => c.id === row.id).componentId.startsWith('citation:')) row.candidates = [goldSelection];
    return response;
  } } });
  assert.equal(observations, 2); assert.equal(result[0].truth, 'correct');
  assert.equal(result[0].citations[0].verdict, 'pending_review');
  assert.equal(componentAttempts.filter(id => id === 'truth:f').length, 2);
  assert.equal(componentAttempts.filter(id => id.startsWith('citation:')).length, 2);
  const source = { id: 'G1', text: 'one writer', span: [47, 57], version: 'v1' };
  const check = { relation: 'full_support', evidence: [{ id: 'G1', unitId: evidenceCatalog(source).units[0].id, quote: source.text, relation: 'full_support', object: 'same', version: 'same', conditions: 'compatible' }] };
  assert.equal(relationTruth(check, [source]), 'correct'); assert.deepEqual(check.evidence[0].originalSpan, [47, 57]);
});
test('budget attempts, successful reads and body versions remain independent with known zero, missing and unknown', () => {
  const fields = executionEvidence({ result: { quality: { budget: { usage: { sourceReads: 3 } } } }, store: { versions: new Map([['v1', {}]]), passages: new Map() } }, {});
  const truth = (field, n) => operationalTruth({ mapping: 'exact', fieldId: 'E-observations.' + field, assertedValue: n }, fields);
  assert.equal(truth('sourceReads', 3), 'correct'); assert.equal(truth('successfulBodyReads', 3), 'unverifiable'); assert.equal(truth('documentVersions', 3), 'incorrect');
  const f = fields.find(f => f.field === 'successfulBodyReads'); assert.match(f.object, /successful/); assert.equal(f.value, null);
  f.state = 'known'; f.value = 0; assert.equal(truth('successfulBodyReads', 0), 'correct'); assert.equal(truth('successfulBodyReads', 3), 'incorrect');
  f.state = 'unknown'; assert.equal(truth('successfulBodyReads', 0), 'pending_review');
});
test('receipt, normalized candidates and coverage checkpoints recover without dispatch or double charge', async t => {
  for (const boundary of ['receipt', 'partial', 'audit']) {
    const directory = path.join(temp(t), boundary); let calls = 0, savedFlight;
    const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
      calls++; const input = JSON.parse(messages[1].content);
      if (boundary === 'partial' && calls === 2) {
        const file = fs.readdirSync(directory).find(f => f.startsWith('accepted-'));
        savedFlight = { file, state: readJson(path.join(directory, file)) };
      }
      if (input.bindings) return { text: JSON.stringify(bindingResponse(input)), usage: { totalTokens: 10 } };
      return { text: JSON.stringify({ blocks: input.blocks.map(b => b.facts ? audit(b) : { id: b.id, classification: 'content', facts: boundary === 'partial' && calls === 1 ? [rawFact(b, b.text), rawFact(b, 'invented')] : [rawFact(b, b.text)] }) }), usage: { totalTokens: 10 } };
    } } };
    const first = await extractReportFacts('A is true.', new Judge(options)); assert.equal(first.extractionComplete, true);
    const before = calls;
    const files = fs.readdirSync(directory).filter(f => f.startsWith('accepted-'));
    // Simulate loss of each normalization/audit checkpoint after safe responses exist.
    if (boundary === 'receipt') for (const f of files) fs.unlinkSync(path.join(directory, f));
    else {
      if (boundary === 'partial') writeJson(path.join(directory, savedFlight.file), savedFlight.state);
      else {
        const file = files.find(f => readJson(path.join(directory, f)).accepted['block-1']?.checks);
        fs.unlinkSync(path.join(directory, file));
      }
    }
    const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('duplicate dispatch'); } } });
    const second = await extractReportFacts('A is true.', resumed);
    assert.deepEqual(second, first); assert.equal(calls, before); assert.equal(resumed.usage().confirmedTokens, before * 10);
  }
});
test('freeze requires current code/test identity and all offline checks; plan and locator versions are pinned', t => {
  const directory = temp(t), planFile = path.join(directory, 'plan.md'), validationFile = path.join(directory, 'validation.json'); fs.writeFileSync(planFile, 'Frozen plan.');
  const v = { codeIdentity: evaluatorCodeIdentity(), verificationIdentity: verificationIdentity(), checks: Object.fromEntries(['test', 'lint', 'build', 'diffCheck'].map(k => [k, { passed: true }])) };
  writeJson(validationFile, v); const freeze = freezeVerification(planFile, validationFile, v.codeIdentity);
  assert.equal(freeze.planHash, hash('Frozen plan.')); assert.equal(freeze.locatorVersion, 2); assert.equal(freeze.executionMetricsVersion, 1);
  v.checks.test.passed = false; writeJson(validationFile, v); assert.throws(() => freezeVerification(planFile, validationFile, v.codeIdentity), /incomplete/);
  v.checks.test.passed = true; v.verificationIdentity = 'old'; writeJson(validationFile, v); assert.throws(() => freezeVerification(planFile, validationFile, v.codeIdentity), /changed/);
});
test('v6 reuses unchanged reports, evidence, IDs and oracle ranges from the unexecuted v5 holdouts', () => {
  for (const name of ['development', 'assertion-holdout', 'scoring-holdout']) assert.deepEqual(
    fs.readFileSync(`tests/fixtures/research-quality/v6/${name}.json`), fs.readFileSync(`tests/fixtures/research-quality/v5/${name}.json`));
});
