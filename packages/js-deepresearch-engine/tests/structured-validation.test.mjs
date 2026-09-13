import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchRunner } from '../src/index.mjs';
import { completeValidatedStructure } from '../src/research/structured-validation.mjs';
import { acceptsClaimValidation } from '../src/research/claim-validation.mjs';
import { parseStructuredResponse, STRUCTURED_RESPONSE_VERSION } from '../src/research/structured-response.mjs';
import { FileRunRecorder, loadNamedCheckpoint } from '../src/research/run-recorder.mjs';
import { BudgetManager, wrapProvidersWithBudget } from '../src/research/budget-manager.mjs';
import { canonicalLlm, body } from './helpers/canonical-llm.mjs';

const settings = { llm: {}, search: {}, research: { strategy: 'exploratory',
  exploratory: { maxSteps: 8, minLlmTokens: 0, maxLlmTokens: 100000, autoReadTopK: 0 },
  focused: { fetchMode: 'disabled', evidencePassages: { embedding: { enabled: false } } } } };
const search = { async search() { return [{ title: 'Atlas documentation', url: 'https://atlas.example.com/docs',
  content: body, fetchStatus: 'ok', contentOrigin: 'provided' }]; } };
const counts = () => ({ provider: 0, parse: 0, semanticContract: 0, render: 0 });
const fence = text => '```json\n' + text + '\n```';

for (const purpose of ['claim_validation', 'report', 'narrative_validation']) {
  test(`[V24] ${purpose} accepts prose braces and identical fenced answers through production`, async () => {
    const good = canonicalLlm(), calls = [];
    const llm = { async completeWithMetadata(args) {
      const response = await good.completeWithMetadata(args);
      if (args.purpose === purpose) {
        calls.push(args);
        response.text = 'Explanation uses {braces before the answer.\n' + fence(response.text) + '\nRepeated answer:\n' + fence(response.text);
      }
      return { ...response, finishReason: 'stop' };
    } };
    const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm });
    // Without a recorder, exploration and report each validate their own graph.
    assert.equal(calls.length, purpose === 'claim_validation' ? 2 : 1);
    assert.ok(calls.every(args => args.messages.length === 2));
    assert.equal(result.quality.gate, 'pass');
    assert.equal(result.reportPlan.structuredResponseVersion, STRUCTURED_RESPONSE_VERSION);
    if (purpose === 'claim_validation') assert.equal(calls[0].maxTokens, 0);
  });
}

test('[V24] exact claim and task IDs remain strict before any text cleanup', () => {
  const claims = [{ claimId: '[gap-1]', atomic: true, tasks: [{ taskId: 'task  1' }], comparisonPassages: [] }];
  const valid = { judgments: [{ claimId: '[gap-1]', verdict: 'supported', atomic: true,
    bindings: [{ taskId: 'task  1', answerRelation: 'supported' }] }] };
  const parse = value => parseStructuredResponse(JSON.stringify(value), { accept: v => acceptsClaimValidation(v, claims) });
  assert.equal(parse(valid).ok, true);
  for (const change of [v => v.judgments.push(v.judgments[0]), v => { v.judgments[0].claimId = ''; },
    v => { v.judgments[0].bindings[0].taskId = 'task 1'; }, v => { v.judgments[0].counterPassageIds = ['invented']; }]) {
    const invalid = globalThis.structuredClone(valid); change(invalid); assert.equal(parse(invalid).reason, 'schema_invalid');
  }
});

test('[V24] bounded retries give safe categories and preserve control flow errors', async () => {
  const requests = [], secret = 'private-model-analysis';
  const llm = { async complete(args) { requests.push(args); return secret + '\n' + fence('{"ok":true}') + '\n' + fence('{"ok":false}'); } };
  await assert.rejects(completeValidatedStructure({ llm, purpose: 'claim_validation', researchPhase: 'exploratory',
    counts: counts(), messages: [{ role: 'user', content: '{}' }], accept: v => typeof v.ok === 'boolean', maxTokens: 0 }), error => {
    assert.equal(error.purpose, 'claim_validation'); assert.equal(error.researchPhase, 'exploratory');
    assert.equal(error.failedChecks[0].actual.structuredReason, 'ambiguous_result');
    assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
  assert.equal(requests.length, 2);
  assert.notDeepEqual(requests[0].messages, requests[1].messages);
  assert.ok(!JSON.stringify(requests[1]).includes(secret));
  for (const code of ['BUDGET_EXCEEDED', 'EXTERNAL_CALL_UNKNOWN', 'SEARCH_CHANNEL_UNAVAILABLE', 'ABORT_ERR']) {
    let calls = 0; const error = Object.assign(new Error('interrupt'), { code });
    await assert.rejects(completeValidatedStructure({ llm: { async complete() { calls++; throw error; } },
      purpose: 'claim_validation', counts: counts(), messages: [], accept: () => true, maxTokens: 0 }), e => e === error);
    assert.equal(calls, 1);
  }
});

test('[V24] response recovery preserves truncation and settles known usage once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-structured-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, query: 'fixture', strategy: 'exploratory' });
  const budget = new BudgetManager(settings); budget.executionVersion = 2;
  const boundary = recorder.checkpoint('exploratory-step-complete', { budget: budget.exportCheckpoint() });
  const request = { provider: 'custom', model: null, body: { messages: [], maxTokens: 0 } };
  budget.reserveAttempt('llm-1', 100, { purpose: 'claim_validation' });
  recorder.callStarted({ callId: 'llm-1', kind: 'llm', purpose: 'claim_validation', request });
  recorder.callFinished({ callId: 'llm-1', kind: 'llm', status: 'completed', response: {
    text: '{"ok":true}', finishReason: 'length', usage: { totalTokens: 60 } } });
  budget.settleAttempt('llm-1', { totalTokens: 60 });
  const before = budget.exportCheckpoint();
  const reopened = FileRunRecorder.reopen(dir); reopened.enableRecovery(boundary.checkpointId);
  const wrapped = wrapProvidersWithBudget({ budget, recorder: reopened, llmCallSequence: 1, search: {},
    llm: { async complete() { assert.fail('Saved response must not dispatch'); } } });
  const raw = await wrapped.llm.complete({ purpose: 'claim_validation', messages: [], maxTokens: 0 });
  assert.equal(parseStructuredResponse(raw, { metadata: wrapped.llm.getLastCallMetadata() }).reason, 'truncated');
  assert.deepEqual(budget.exportCheckpoint(), before);
});

test('[V24] older parsing protocol revalidates frozen claims and completed revisions stay stable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-structured-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: '调研 Atlas 这个产品' });
  const good = canonicalLlm();
  await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, recorder,
    llm: { async completeWithMetadata(args) { return args.purpose === 'report'
      ? { text: '', usage: { totalTokens: 100 } } : good.completeWithMetadata(args); } } }), { code: 'REPORT_OUTPUT_INVALID' });
  const previous = loadNamedCheckpoint(dir, 'canonical-claims-validated').state;
  recorder.checkpoint('canonical-claims-validated', { ...previous, structuredResponseVersion: 0 });
  const calls = [];
  const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings,
    recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm({ onCall: args => calls.push(args.purpose) }),
    search: { async search() { assert.fail('Report resume must not search'); } } });
  assert.deepEqual(calls, ['claim_validation', 'report', 'narrative_validation']);
  assert.deepEqual(result.citationRegistry, previous.citationRegistry);
  const completed = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings, recorder: FileRunRecorder.reopen(dir),
    search: { async search() { assert.fail('Completed research must not search'); } },
    llm: { async complete() { assert.fail('Completed research must not dispatch'); } } });
  assert.equal(completed.resultRevision, result.resultRevision);
});

test('[V24] returned invalid output with unknown usage pauses before retry and keeps its reservation', async () => {
  let calls = 0;
  const budget = new BudgetManager(settings); budget.executionVersion = 2;
  const wrapped = wrapProvidersWithBudget({ budget, search: {}, llm: { async completeWithMetadata() {
    calls++; return { text: 'invalid output', finishReason: 'stop' };
  } } });
  const attemptCounts = counts();
  await assert.rejects(completeValidatedStructure({ llm: wrapped.llm, purpose: 'claim_validation',
    messages: [], accept: () => true, counts: attemptCounts, maxTokens: 0 }), { code: 'LLM_USAGE_UNKNOWN' });
  assert.equal(calls, 1);
  assert.equal(budget.reservations.size, 1);
  assert.equal(budget.unknown.llmTokens, true);
  assert.deepEqual(attemptCounts, counts());
});
