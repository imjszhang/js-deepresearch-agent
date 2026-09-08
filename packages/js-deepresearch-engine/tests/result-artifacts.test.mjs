import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveResearchArtifacts } from '../src/research/work-output.mjs';
import { resolveResearchArtifacts, publishResearchArtifacts } from '../src/research/result-artifacts.mjs';
import { FileRunRecorder } from '../src/research/run-recorder.mjs';
import { selectResearchResumePlan } from '../src/research/resume-plan.mjs';

test('versioned results never mix with root mirrors or incomplete revisions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { sessionDir: dir, query: 'q', strategy: 'quick', settings: {},
    result: { resultRevision: 'v1', report: '# First', findings: [], sources: [] } };
  const first = saveResearchArtifacts(options);
  const second = saveResearchArtifacts({ ...options, publish: false, result: { ...options.result, resultRevision: 'v2', report: '# Second' } });
  fs.writeFileSync(path.join(dir, 'report.md'), '# Incorrect mirror');
  assert.equal(fs.readFileSync(resolveResearchArtifacts(dir).reportPath, 'utf8'), '# First');
  publishResearchArtifacts(second);
  assert.equal(fs.readFileSync(resolveResearchArtifacts(dir).reportPath, 'utf8'), '# Second');
  assert.equal(fs.readFileSync(first.reportPath, 'utf8'), '# First');
  fs.writeFileSync(second.sourcesPath, '[] changed');
  assert.throws(() => resolveResearchArtifacts(dir), /integrity/);
});

test('failed version preparation leaves the previous pointer untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { sessionDir: dir, query: 'q', strategy: 'quick', settings: {},
    result: { resultRevision: 'v1', report: '# First', findings: [], sources: [] } };
  saveResearchArtifacts(options);
  fs.mkdirSync(path.join(dir, 'results', 'v2', 'sources.json'), { recursive: true });
  assert.throws(() => saveResearchArtifacts({ ...options, result: { ...options.result, resultRevision: 'v2' } }));
  assert.equal(resolveResearchArtifacts(dir).resultRevision, 'v1');
  assert.equal(resolveResearchArtifacts(fs.mkdtempSync(path.join(dir, 'legacy-'))).resultRevision, null);
});

test('a newer continuation checkpoint takes precedence over an old final result', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir });
  recorder.checkpoint('pre-report', {});
  recorder.checkpoint('research-complete', { result: { report: '# Done', sources: [], findings: [], quality: {} } });
  assert.equal(selectResearchResumePlan({ sessionDir: dir }).mode, 'commit-result');
  recorder.checkpoint('exploratory-continuation-start', { step: 3, maxSteps: 5, loopLocal: {} });
  const plan = selectResearchResumePlan({ sessionDir: dir });
  assert.equal(plan.mode, 'mid-loop');
  assert.equal(plan.checkpoint.state.maxSteps, 5);
});

test('v2 manifests own all evidence bodies and reject corruption without legacy fallback', async (t) => {
  const { EvidenceStore } = await import('../src/research/evidence-store.mjs');
  const { readArtifactEvidence } = await import('../src/research/result-artifacts.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-evidence-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EvidenceStore();
  const version = store.register({ url: 'https://example.org/tool', content: 'The tool processes local documents and is released under the Example License.', fetchStatus: 'ok' }, 'task');
  const passage = store.chunks(version.documentVersionId)[0];
  const registry = { schemaVersion: 1, entries: [{ citationKey: '7.1', sourceId: version.sourceId, documentVersionId: version.documentVersionId, passageIds: [passage.id], url: version.url }] };
  const result = { resultRevision: 'canonical', report: '# Report\n\nTool [7.1]', findings: [], sources: [], evidenceStore: store.export(), citationRegistry: registry, evidenceAppendix: '# Evidence' };
  const artifacts = saveResearchArtifacts({ sessionDir: dir, query: 'tool', strategy: 'focused', settings: {}, result });
  assert.equal(resolveResearchArtifacts(dir).schemaVersion, 2);
  assert.equal(readArtifactEvidence(artifacts).body(version.documentVersionId), store.body(version.documentVersionId));
  fs.writeFileSync(path.join(dir, 'report.md'), '# Old root report');
  fs.writeFileSync(path.join(artifacts.resultDir, version.bodyRef), 'tampered');
  assert.throws(() => resolveResearchArtifacts(dir), /integrity/);
});

test('latest budget receipt survives the response-before-application crash window', async (t) => {
  const { BudgetManager, wrapProvidersWithBudget } = await import('../src/research/budget-manager.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-receipt-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, query: 'tool', strategy: 'exploratory' });
  const budget = new BudgetManager({ research: { exploratory: { minLlmTokens: 50, maxLlmTokens: 1000 } } });
  budget.executionVersion = 2;
  recorder.checkpoint('exploratory-action-start', { executionVersion: 2, budget: budget.exportCheckpoint(), loopLocal: {} });
  budget.reserveAttempt('llm-1', 100, { purpose: 'gap_support' });
  recorder.checkpoint('budget-ledger', { budget: budget.exportCheckpoint() });
  const request = { provider: 'custom', model: null, body: { messages: [{ role: 'user', content: 'inspect' }], maxTokens: 10 } };
  recorder.setActionContext({ actionId: 'action-one', attemptId: 'attempt-one' });
  recorder.callStarted({ callId: 'llm-1', kind: 'llm', purpose: 'gap_support', request });
  recorder.callFinished({ callId: 'llm-1', kind: 'llm', status: 'completed', response: { text: 'known result', usage: { totalTokens: 60 } } });
  const plan = selectResearchResumePlan({ sessionDir: dir });
  const restoredBudget = new BudgetManager().restoreCheckpoint(plan.checkpoint.state.budget);
  assert.equal(restoredBudget.usage.explorationTokens, 60);
  assert.equal(restoredBudget.reservedTokens(), 0);
  const reopened = FileRunRecorder.reopen(dir);
  reopened.enableRecovery(plan.checkpoint.checkpoint.checkpointId);
  reopened.setActionContext({ actionId: 'action-one', attemptId: 'attempt-two' });
  const provider = wrapProvidersWithBudget({ budget: restoredBudget, recorder: reopened, llmCallSequence: 1,
    llm: { async complete() { assert.fail('Known response must not call provider'); } }, search: {} });
  assert.equal(await provider.llm.complete({ purpose: 'gap_support', messages: request.body.messages, maxTokens: 10 }), 'known result');
  assert.equal(restoredBudget.usage.explorationTokens, 60);
});
