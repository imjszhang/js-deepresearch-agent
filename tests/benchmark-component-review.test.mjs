import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewItems } from '../scripts/benchmark/quality/item-review.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';

const temp = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-component-review-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
const args = (judge, ids = ['a', 'b'], extra = {}) => ({ judge, purpose: 'fixture', instructions: 'semantic component contract', field: 'components',
  input: { bodyTable: 'physical batch view', components: ids.map(id => ({ id, fact: id })) },
  components: { scope: { reportHash: 'report', purpose: 'semantic-components' }, dependencies: item => ({ fact: item.fact, materialHash: 'body-v1', policyVersion: 1 }) },
  validateItem: value => assert.equal(value.ok, true), pendingItem: (item, pendingReason) => ({ id: item.id, pendingReason }), ...extra });
const states = directory => fs.readdirSync(directory).filter(name => name.startsWith('components-')).map(name => ({ file: path.join(directory, name), state: readJson(path.join(directory, name)) }));
const attempts = state => Object.fromEntries(Object.entries(state.records).map(([key, record]) => [record.item.id, state.attempts[key] || 0]));

test('accepted components survive physical regrouping and only invalid siblings consume a repair', async t => {
  const directory = temp(t), dispatched = [];
  const judge = { directory, identity: { model: 'frozen' }, supportsDispatch: true, async ask(_, __, input, ___, ____, options) {
    options.onDispatch(); dispatched.push(input.components.map(c => c.id));
    return { components: input.components.map(c => ({ id: c.id, ok: c.id !== 'b' || dispatched.length > 1 })) };
  } };
  assert.ok((await reviewItems(args(judge))).every(x => x.ok));
  const next = args(judge, ['c', 'b']); next.input.bodyTable = 'new batch includes other sources';
  assert.ok((await reviewItems(next)).every(x => x.ok));
  assert.deepEqual(dispatched, [['a', 'b'], ['b'], ['c']]);
  const [saved] = states(directory); assert.equal(states(directory).length, 1);
  assert.deepEqual(attempts(saved.state), { a: 1, b: 2, c: 1 });
});

test('a changed material dependency revalidates only that component', async t => {
  const directory = temp(t), dispatched = [];
  const judge = { directory, async ask(_, __, input) { dispatched.push(input.components.map(c => c.id)); return { components: input.components.map(c => ({ id: c.id, ok: true })) }; } };
  await reviewItems(args(judge));
  const next = args(judge); next.components.dependencies = item => ({ fact: item.fact, materialHash: item.id === 'b' ? 'body-v2' : 'body-v1', policyVersion: 1 });
  await reviewItems(next); assert.deepEqual(dispatched, [['a', 'b'], ['b']]);
  const [saved] = states(directory); assert.equal(Object.keys(saved.state.accepted).length, 3);
});

test('physical output caps do not reset accepted components or exhausted attempt counters', async t => {
  const directory = temp(t), sent = [];
  const judge = { directory, async ask(_, __, input, ___, maxTokens) {
    sent.push({ ids: input.components.map(c => c.id), maxTokens });
    return { components: input.components.map(c => ({ id: c.id, ok: c.id === 'a' })) };
  } };
  const first = await reviewItems(args(judge, ['a', 'b'], { maxTokens: 200 }));
  assert.equal(first[0].ok, true); assert.ok(first[1].pendingReason);
  await reviewItems(args(judge, ['b', 'a'], { maxTokens: 4000 }));
  assert.equal(sent.length, 2); assert.equal(states(directory).length, 1);
  assert.deepEqual(attempts(states(directory)[0].state), { a: 1, b: 2 });
});

test('component cache rejects reuse across model, stage, instructions and logical scope', async t => {
  const directory = temp(t); let calls = 0;
  const makeJudge = (identity = {}, stage = 'dev') => ({ directory, identity, stage, async ask(_, __, input) { calls++; return { components: input.components.map(c => ({ id: c.id, ok: true })) }; } });
  await reviewItems(args(makeJudge(), ['a']));
  await reviewItems(args(makeJudge(), ['a'])); assert.equal(calls, 1);
  await reviewItems(args(makeJudge({ model: 'new-model' }), ['a']));
  await reviewItems(args(makeJudge({}, 'holdout'), ['a']));
  await reviewItems(args(makeJudge(), ['a'], { instructions: 'new protocol' }));
  const changed = args(makeJudge(), ['a']); changed.components.scope = 'other-report'; await reviewItems(changed);
  assert.equal(calls, 5);
});

test('structural feedback preserves safe code, field and allowed IDs without free-form error text', async t => {
  const directory = temp(t); let calls = 0;
  const judge = { directory, async ask(_, __, input) {
    calls++;
    if (calls === 2) {
      assert.deepEqual(input.repair.errors.a, { code: 'relation_anchor_unknown', field: 'evidence[0].id', allowedIds: ['G1', 'P:2'] });
      assert.equal(input.repair.codes.a, 'relation_anchor_unknown');
      assert.ok(!JSON.stringify(input).includes('PRIVATE REPORT TEXT'));
    }
    return { components: [{ id: 'a', ok: calls === 2 }] };
  } };
  await reviewItems(args(judge, ['a'], { validateItem: value => {
    if (!value.ok) throw Object.assign(Error('PRIVATE REPORT TEXT'), { code: 'relation_anchor_unknown', details: { field: 'evidence[0].id', allowedIds: ['G1', 'P:2', 'G1', 'PRIVATE REPORT TEXT'], rationale: 'PRIVATE REPORT TEXT' } });
  } }));
  assert.equal(calls, 2); assert.ok(!fs.readFileSync(states(directory)[0].file, 'utf8').includes('PRIVATE REPORT TEXT'));
});

test('malformed validator feedback cannot inject arbitrary messages or field names', async () => {
  let calls = 0;
  const judge = { async ask(_, __, input) {
    calls++; if (calls === 2) assert.deepEqual(input.repair.errors.a, { code: 'item_contract_invalid', allowedIds: [] });
    return { components: [{ id: 'a', ok: calls === 2 }] };
  } };
  await reviewItems(args(judge, ['a'], { validateItem: value => {
    if (!value.ok) throw Object.assign(Error('private'), { code: 'private prose', field: 'private report text', allowedIds: [null, {}, 'not an id'] });
  } }));
  assert.equal(calls, 2);
});

test('unknown dispatched batch retains exact original input across repackaging and recovers its receipt first', async t => {
  const directory = temp(t); let calls = 0;
  const firstJudge = new Judge({ directory, identity: {}, llm: { async completeWithMetadata() { calls++; throw Error('uncertain'); } } });
  assert.ok((await reviewItems(args(firstJudge))).every(x => x.pendingReason === 'provider_pending'));
  const originalFlight = states(directory)[0].state.inflight;
  const repacked = args(firstJudge, ['c'], { maxTokens: 1234 }); repacked.input.bodyTable = 'different physical input';
  assert.equal((await reviewItems(repacked))[0].pendingReason, 'provider_pending'); assert.equal(calls, 1);
  assert.deepEqual(states(directory)[0].state.inflight, originalFlight);
  const callId = Object.keys(firstJudge.ledger.calls)[0];
  writeJson(path.join(directory, callId + '.json'), { text: JSON.stringify({ components: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }), usage: { totalTokens: 15 }, activeMs: 1 });
  const restored = new Judge({ directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content); assert.deepEqual(input.components.map(c => c.id), ['c']);
    return { text: JSON.stringify({ components: [{ id: 'c', ok: true }] }), usage: { totalTokens: 11 } };
  } } });
  const oldDependencies = [];
  repacked.validateItem = (value, originalItem, context) => {
    oldDependencies.push([originalItem.id, context.dependencies.materialHash]); assert.equal(value.ok, true);
  };
  repacked.judge = restored; assert.equal((await reviewItems(repacked))[0].ok, true);
  assert.deepEqual(oldDependencies, [['a', 'body-v1'], ['b', 'body-v1'], ['c', 'body-v1']]);
  assert.ok((await reviewItems(args(restored))).every(x => x.ok));
  assert.equal(calls, 2); assert.equal(restored.usage().confirmedTokens, 26); assert.equal(restored.usage().unknownCalls, 0);
  assert.deepEqual(attempts(states(directory)[0].state), { a: 1, b: 1, c: 1 });
});

test('an undispatched reservation failure may be repacked without consuming or resetting an attempt', async t => {
  const directory = temp(t); let dispatches = 0;
  const judge = { directory, supportsDispatch: true, async ask(_, __, input, ___, ____, options) {
    if (input.bodyTable === 'physical batch view') throw Error('JUDGE_BUDGET_EXCEEDED');
    options.onDispatch(); dispatches++; return { components: input.components.map(c => ({ id: c.id, ok: true })) };
  } };
  assert.equal((await reviewItems(args(judge, ['a'])))[0].pendingReason, 'budget_pending');
  assert.deepEqual(attempts(states(directory)[0].state), { a: 0 });
  const smaller = args(judge, ['a']); smaller.input.bodyTable = 'compact same material view';
  assert.equal((await reviewItems(smaller))[0].ok, true); assert.equal(dispatches, 1);
  assert.deepEqual(attempts(states(directory)[0].state), { a: 1 });
});

test('[V13] recovering another flight unblocks a previously undispatched budget component without resetting attempts', async t => {
  const directory = temp(t), dispatches = []; let phase = 'budget';
  const judge = { directory, supportsDispatch: true, async ask(_, __, input, ___, ____, options) {
    const id = input.components[0].id;
    if (phase === 'budget') { assert.equal(id, 'c'); throw Error('JUDGE_BUDGET_EXCEEDED'); }
    if (phase === 'unknown') { options.onDispatch(); dispatches.push(id); throw Error('JUDGE_PROVIDER_FAILED'); }
    if (id === 'a') return { components: [{ id: 'a', ok: true }] }; // Late receipt: no dispatch callback.
    options.onDispatch(); dispatches.push(id); return { components: [{ id: 'c', ok: true }] };
  } };
  assert.equal((await reviewItems(args(judge, ['c'])))[0].pendingReason, 'budget_pending');
  phase = 'unknown'; assert.equal((await reviewItems(args(judge, ['a'])))[0].pendingReason, 'provider_pending');
  assert.deepEqual(attempts(states(directory)[0].state), { c: 0, a: 1 });
  phase = 'receipt'; assert.deepEqual(await reviewItems(args(judge, ['c'])), [{ id: 'c', ok: true }]);
  assert.deepEqual(dispatches, ['a', 'c']); assert.deepEqual(attempts(states(directory)[0].state), { c: 1, a: 1 });
});

test('reservation splitting and regrouping cannot give exhausted components a third dispatch', async t => {
  const directory = temp(t), sent = [];
  const judge = { directory, supportsDispatch: true, async ask(_, __, input, ___, ____, options) {
    if (input.components.length > 1) throw Error('JUDGE_BUDGET_EXCEEDED');
    options.onDispatch(); sent.push(input.components[0].id); return { components: [{ id: input.components[0].id, ok: false }] };
  } };
  assert.ok((await reviewItems(args(judge))).every(x => x.pendingReason));
  const repacked = args(judge, ['b', 'a']); repacked.input.bodyTable = 'different'; await reviewItems(repacked);
  assert.deepEqual(sent, ['a', 'b', 'a', 'b']);
  assert.deepEqual(attempts(states(directory)[0].state), { a: 2, b: 2 });
});

test('accepted normalized siblings survive a checkpoint interrupted before the flight clears', async t => {
  const directory = temp(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    return { text: JSON.stringify({ components: input.components.map(c => ({ id: c.id, ok: true })) }), usage: { totalTokens: 13 } };
  } } };
  const judge = new Judge(options); let interrupted;
  const firstArgs = args(judge, ['a', 'b'], { validateItem: value => {
    assert.equal(value.ok, true);
    if (value.id === 'b') interrupted = globalThis.structuredClone(states(directory)[0].state);
  } });
  await reviewItems(firstArgs); assert.ok(interrupted.inflight); assert.equal(Object.keys(interrupted.accepted).length, 1);
  const [{ file }] = states(directory); writeJson(file, interrupted);
  const restored = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('must recover response'); } } });
  const seen = [];
  assert.ok((await reviewItems(args(restored, ['b'], { validateItem: value => { seen.push(value.id); assert.equal(value.ok, true); } }))).every(x => x.ok));
  assert.deepEqual(seen, ['b']); assert.equal(calls, 1); assert.equal(restored.usage().confirmedTokens, 13);
});

test('checkpoint write failures stop review instead of spending a structural retry', async t => {
  const root = temp(t), directory = path.join(root, 'judge'); fs.mkdirSync(directory); let calls = 0;
  const judge = { directory, async ask(_, __, input) {
    calls++;
    fs.renameSync(directory, path.join(root, 'saved-judge')); fs.writeFileSync(directory, 'blocks directory writes');
    return { components: input.components.map(c => ({ id: c.id, ok: true })) };
  } };
  await assert.rejects(reviewItems(args(judge)), /EVALUATION_CHECKPOINT_WRITE_FAILED/);
  assert.equal(calls, 1);
  const [saved] = states(path.join(root, 'saved-judge')); assert.equal(saved.state.inflight.dispatched, true);
});

test('component dependency declaration is mandatory and rejects duplicate IDs', async () => {
  const judge = { async ask() { assert.fail('must not dispatch'); } };
  await assert.rejects(reviewItems(args(judge, ['a'], { components: { scope: 'x' } })), /DEPENDENCIES_REQUIRED/);
  const missing = args(judge, ['a']); missing.components.dependencies = () => undefined;
  await assert.rejects(reviewItems(missing), /DEPENDENCIES_REQUIRED/);
  await assert.rejects(reviewItems(args(judge, ['a', 'a'])), /COMPONENT_IDS/);
});

test('in-memory component reviews also preserve stable identities across batches', async () => {
  let calls = 0;
  const judge = { async ask(_, __, input) { calls++; return { components: input.components.map(c => ({ id: c.id, ok: true })) }; } };
  await reviewItems(args(judge)); await reviewItems(args(judge, ['b'])); assert.equal(calls, 1);
  const next = args(judge, ['b']); next.components.dependencies = item => ({ fact: item.fact, materialHash: hash('new material') });
  await reviewItems(next); assert.equal(calls, 2);
});

for (const scenario of [
  { name: 'missing', rows: [{ id: 'a', ok: true }], missingIds: ['b'], duplicateIds: [], unknownIdCount: 0 },
  { name: 'duplicate', rows: [{ id: 'a', ok: true }, { id: 'a', ok: true }], missingIds: ['b'], duplicateIds: ['a'], unknownIdCount: 0 },
  { name: 'extra', rows: [{ id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'PRIVATE_UNKNOWN_ID', ok: true }], missingIds: [], duplicateIds: [], unknownIdCount: 1 },
  { name: 'unknown', rows: [{ id: 'a', ok: true }, { id: 'PRIVATE_UNKNOWN_ID', ok: true }], missingIds: ['b'], duplicateIds: [], unknownIdCount: 1 },
  { name: 'empty', rows: [], missingIds: ['a', 'b'], duplicateIds: [], unknownIdCount: 0 },
  { name: 'non-array', rows: {}, missingIds: ['a', 'b'], duplicateIds: [], unknownIdCount: 0 },
]) test('[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: ' + scenario.name, async t => {
  const directory = temp(t), requests = [];
  const options = { directory, identity: { model: 'scripted-id-contract' }, llm: { async completeWithMetadata({ messages }) {
    const input = JSON.parse(messages[1].content); requests.push(input);
    assert.ok(requests.length <= 2);
    if (requests.length === 2) {
      assert.deepEqual(input.components.map(c => c.id), ['a', 'b']);
      for (const id of ['a', 'b']) {
        assert.equal(input.repair.codes[id], 'id_set_invalid');
        assert.deepEqual(input.repair.errors[id], { code: 'id_set_invalid', field: 'components.id', allowedIds: ['a', 'b'],
          missingIds: scenario.missingIds, duplicateIds: scenario.duplicateIds, unknownIdCount: scenario.unknownIdCount,
          receivedCount: Array.isArray(scenario.rows) ? scenario.rows.length : 0, expectedCount: 2, arrayProvided: Array.isArray(scenario.rows) });
      }
      assert.equal(JSON.stringify(input.repair).includes('PRIVATE_UNKNOWN_ID'), false);
    }
    return { text: JSON.stringify({ components: requests.length === 1 ? scenario.rows : [{ id: 'a', ok: true }, { id: 'b', ok: true }] }), usage: { totalTokens: 3 } };
  } } };
  const first = await reviewItems(args(new Judge(options)));
  assert.deepEqual(first, [{ id: 'a', ok: true }, { id: 'b', ok: true }]);
  assert.equal(requests.length, 2); assert.deepEqual(attempts(states(directory)[0].state), { a: 2, b: 2 });
  const ledger = readJson(path.join(directory, 'ledger.json'));
  const invalid = Object.values(ledger.calls).find(c => c.validationFailure === 'id_set_invalid');
  assert.equal(invalid.validationDetails.code, 'id_set_invalid');
  assert.equal(JSON.stringify(invalid).includes('PRIVATE_UNKNOWN_ID'), false);
  const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('receipt must be reused'); } } });
  assert.deepEqual(await reviewItems(args(resumed, ['b', 'a'])), [first[1], first[0]]);
  assert.equal(resumed.usage().confirmedTokens, 6);
});

test('[V03] a malformed retry cannot resend an accepted sibling or gain a third attempt after restart', async t => {
  const directory = temp(t), requests = [];
  const options = { directory, identity: { model: 'scripted-id-contract' }, llm: { async completeWithMetadata({ messages }) {
    const input = JSON.parse(messages[1].content); requests.push(input.components.map(c => c.id));
    assert.ok(requests.length <= 2);
    const components = requests.length === 1 ? [{ id: 'a', ok: true }, { id: 'b', ok: false }] : [{ id: 'wrong', ok: true }];
    return { text: JSON.stringify({ components }), usage: { totalTokens: 5 } };
  } } };
  const first = await reviewItems(args(new Judge(options)));
  assert.deepEqual(first, [{ id: 'a', ok: true }, { id: 'b', pendingReason: 'id_set_invalid' }]);
  assert.deepEqual(requests, [['a', 'b'], ['b']]);
  const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('attempt cap'); } } });
  assert.deepEqual(await reviewItems(args(resumed, ['b', 'a'])), [first[1], first[0]]);
  assert.deepEqual(attempts(states(directory)[0].state), { a: 1, b: 2 });
});
