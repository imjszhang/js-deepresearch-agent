import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { exactIds, JUDGE_VERSION, readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { requireCalibration } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { reviewItems } from '../scripts/benchmark/quality/item-review.mjs';
import { materialFromEvidence, reviewRelationComponents } from '../scripts/benchmark/quality/relation-components.mjs';
import { decisionResponse, basisAuditResponse } from './helpers/quality-relations.mjs';
import { STRUCTURED_RESPONSE_VERSION } from '../packages/js-deepresearch-engine/src/research/structured-response.mjs';

const answer = { facts: [{ id: 'f1', relation: 'supported' }] };
const validate = value => {
  exactIds(value.facts, ['f1'], 'id', 'facts.id');
  assert.equal(value.facts[0].relation, 'supported');
};
const fence = value => '```json\n' + JSON.stringify(value) + '\n```';
function setup(t, responses) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-judge-structured-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], options = { directory, identity: { model: 'scripted-response-boundary' }, assessmentOrigin: 'scripted_fixture',
    llm: { async completeWithMetadata(request) {
      requests.push(request); assert.ok(requests.length <= responses.length, 'unexpected model dispatch');
      return { usage: { totalTokens: 7 }, finishReason: 'stop', ...responses[requests.length - 1] };
    } } };
  return { directory, requests, options, judge: new Judge(options) };
}
const ask = (judge, options = {}) => judge.ask('verify_facts', 'Return the exact fact IDs.', { ids: ['f1'] }, validate, 100, options);
const contents = directory => fs.readdirSync(directory).map(file => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n');

for (const [label, text] of [
  ['prose braces before complete JSON', 'Explanation uses { placeholder }.\n' + fence(answer)],
  ['repeated identical complete JSON', fence(answer) + '\nSame response:\n' + fence({ facts: [{ relation: 'supported', id: 'f1' }] })],
  ['explicit reasoning excluded', '<think>' + fence({ facts: [{ id: 'wrong' }] }) + '</think>\n' + fence(answer)],
]) test('[V24] benchmark selects ' + label + ' once and replays without billing', async t => {
  const { options, judge, requests, directory } = setup(t, [{ text }]);
  assert.deepEqual(await ask(judge), answer); assert.equal(requests.length, 1);
  const before = judge.usage();
  const replay = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('receipt must not dispatch'); } } });
  assert.deepEqual(await ask(replay), answer); assert.deepEqual(replay.usage(), before);
  const response = readJson(path.join(directory, fs.readdirSync(directory).find(file => file !== 'ledger.json')));
  assert.equal(response.parsing.version, STRUCTURED_RESPONSE_VERSION); assert.equal(response.parsing.ok, true);
  assert.deepEqual(JSON.parse(response.text), answer);
});

for (const [label, first, reason] of [
  ['conflicting judgments', { text: fence(answer) + '\n' + fence({ facts: [{ id: 'f1', relation: 'unsupported' }] }) }, 'ambiguous_result'],
  ['differences hidden by projection', { text: fence({ ...answer, arbitraryNotes: 'PRIVATE_FIRST' }) + '\n' + fence({ ...answer, arbitraryNotes: 'PRIVATE_SECOND' }) }, 'ambiguous_result'],
  ['duplicate JSON keys', { text: '{"facts":[{"id":"f1","relation":"unsupported","relation":"supported"}]}' }, 'invalid_json'],
  ['truncated yet complete answer', { text: fence(answer), finishReason: 'length' }, 'truncated'],
  ['incomplete answer', { text: '{"facts":[{"id":"f1"}' }, 'no_complete_json'],
]) test('[V24] benchmark rejects ' + label + ' before projection and sends safe retry feedback', async t => {
  const { judge, requests, directory } = setup(t, [first, { text: fence(answer) }]);
  assert.deepEqual(await ask(judge), answer); assert.equal(requests.length, 2);
  assert.notDeepEqual(requests[0].messages, requests[1].messages);
  assert.ok(JSON.stringify(requests[1].messages).includes(reason));
  const ledger = readJson(path.join(directory, 'ledger.json'));
  assert.equal(Object.values(ledger.calls).find(call => call.validationFailure)?.validationFailure, reason);
  const rejected = Object.keys(ledger.calls).map(id => readJson(path.join(directory, `${id}.json`))).find(response => !response.parsing.ok);
  assert.equal(rejected.text, ''); assert.equal(rejected.parsing.reason, reason);
  assert.equal(judge.usage().confirmedTokens, 14);
  assert.equal(contents(directory).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(requests[1].messages).includes('PRIVATE_'), false);
});

test('[V24] persisted parse failures stay rejected after restart without redispatch or erased ID diagnostics', async t => {
  const { judge, options, directory, requests } = setup(t, [{ text: fence({ facts: [{ id: 'PRIVATE_UNKNOWN_ID' }] }) }]);
  await assert.rejects(ask(judge, { maxAttempts: 1 }), error => error.message === 'JUDGE_STRUCTURE_INVALID'
    && error.code === 'id_set_invalid' && error.details.unknownIdCount === 1 && error.details.missingIds[0] === 'f1');
  const before = judge.usage(), replay = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('must recover rejection'); } } });
  await assert.rejects(ask(replay, { maxAttempts: 1 }), error => error.code === 'id_set_invalid' && error.details.unknownIdCount === 1);
  assert.deepEqual(replay.usage(), before); assert.equal(requests.length, 1);
  assert.equal(contents(directory).includes('PRIVATE_UNKNOWN_ID'), false);
});

test('[V24] business validation sees original fields before privacy projection', async t => {
  const { judge, directory, requests } = setup(t, [{ text: JSON.stringify({ ...answer, forbidden: 'PRIVATE_EXTRA_FIELD' }) }]);
  await assert.rejects(judge.ask('verify_facts', 'Only facts are permitted.', {}, candidate => {
    validate(candidate); assert.deepEqual(Object.keys(candidate), ['facts']);
  }, 100, { maxAttempts: 1 }), /JUDGE_STRUCTURE_INVALID/);
  assert.equal(requests.length, 1); assert.equal(contents(directory).includes('PRIVATE_EXTRA_FIELD'), false);
  const receipt = readJson(path.join(directory, fs.readdirSync(directory).find(file => file !== 'ledger.json')));
  assert.equal(receipt.parsing.reason, 'schema_invalid'); assert.equal(receipt.text, '');
});

test('[V24] component-owned retry receives the structural reason without replaying model prose', async t => {
  const { judge, requests } = setup(t, [{ text: fence(answer) + '\n' + fence({ facts: [{ id: 'f1', relation: 'unsupported' }] }) }, { text: fence(answer) }]);
  const facts = await reviewItems({ judge, purpose: 'verify_facts', instructions: 'Return exact fact IDs.', field: 'facts',
    input: { facts: [{ id: 'f1' }] }, validateItem: value => assert.equal(value.relation, 'supported'),
    pendingItem: (item, pendingReason) => ({ id: item.id, pendingReason }), maxTokens: 100 });
  assert.deepEqual(facts, answer.facts); assert.equal(requests.length, 2);
  const retry = JSON.parse(requests[1].messages[1].content);
  assert.equal(retry.repair.codes.f1, 'schema_ambiguous_result');
  assert.deepEqual(retry.repair.errors.f1, { code: 'schema_ambiguous_result' });
});

test('[V24] known candidate parsing failure still falls back to complete material after bounded retries', async t => {
  const material = materialFromEvidence({ id: 'manual', text: 'No measurements were recorded.', sourceId: 'manual', version: 'v1' });
  const { judge, requests } = setup(t, []);
  judge.llm = { async completeWithMetadata(request) {
    requests.push(request); const input = JSON.parse(request.messages[1].content);
    assert.ok(requests.length <= 4);
    if (requests.length <= 2) return { text: 'PRIVATE_MALFORMED_RESPONSE', usage: { totalTokens: 7 } };
    assert.equal(input.bodies[0].text, material.source.text);
    const result = requests.length === 3 ? decisionResponse(input, () => 'not_addressed') : basisAuditResponse(input);
    if (requests.length === 3) assert.deepEqual(input.checks[0].candidates, []);
    return { text: JSON.stringify(result), usage: { totalTokens: 7 } };
  } };
  const [result] = await reviewRelationComponents({ judge, reportHash: 'parser-fallback', materials: [material],
    tasks: [{ id: 'truth:f1', proposition: 'There are measurements.', kind: 'fact', materialIds: [material.id] }] });
  assert.equal(result.truth, 'unverifiable'); assert.equal(requests.length, 4);
  assert.equal(result.checks[0].discovery.pendingReason, 'schema_no_complete_json');
  assert.equal(result.checks[0].discovery.fallback, 'full_material');
  assert.equal(result.checks[0].pendingReason, undefined);
});

test('[V24] rejected response with unknown usage retains reservation and prevents retry', async t => {
  const { judge, requests } = setup(t, [{ text: 'PRIVATE_INVALID_TEXT', usage: null }]);
  await assert.rejects(ask(judge), /JUDGE_OUTCOME_UNKNOWN/);
  assert.equal(requests.length, 1); assert.equal(judge.usage().unknownCalls, 1);
  assert.ok(judge.usage().reservedUnknownTokens > 0); assert.equal(judge.usage().confirmedTokens, 0);
});

test('[V24] unknown candidate parsing usage cannot enter full-material fallback', async t => {
  const material = materialFromEvidence({ id: 'manual', text: 'No measurements were recorded.', sourceId: 'manual', version: 'v1' });
  const { judge, requests } = setup(t, [{ text: 'PRIVATE_MALFORMED_RESPONSE', usage: null }]);
  const [result] = await reviewRelationComponents({ judge, reportHash: 'parser-unknown-fallback', materials: [material],
    tasks: [{ id: 'truth:f1', proposition: 'There are measurements.', kind: 'fact', materialIds: [material.id] }] });
  assert.equal(result.truth, 'pending_review'); assert.equal(requests.length, 1);
  assert.equal(result.pendingReason, 'provider_pending'); assert.equal(result.checks[0].discovery.fallback, undefined);
  assert.equal(judge.usage().unknownCalls, 1); assert.ok(judge.usage().reservedUnknownTokens > 0);
});

test('[V24] parsing and calibration identities reject old protocol without rewriting history', t => {
  assert.equal(JUDGE_VERSION, 'quality-judge-10');
  assert.throws(() => requireCalibration({ schemaVersion: 5, judgeVersion: 'quality-judge-9', machineCalibrationPassed: true }), /Calibration gate/);
  const { directory, options } = setup(t, []);
  const ledgerFile = path.join(directory, 'ledger.json'), ledger = readJson(ledgerFile);
  ledger.policyHash = 'historical-parser-policy'; writeJson(ledgerFile, ledger);
  const before = fs.readFileSync(ledgerFile, 'utf8');
  assert.throws(() => new Judge(options), /JUDGE_POLICY_CHANGED/);
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
});
