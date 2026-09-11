import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunExecutionConfig, resolveRunExecutionSettings } from '../src/research/run-execution-config.mjs';
import { ResearchRunner } from '../src/research/research-runner.mjs';
import { FileRunRecorder, loadNamedCheckpoint } from '../src/research/run-recorder.mjs';
import { canonicalLlm, body } from './helpers/canonical-llm.mjs';
import { SearchProviderError } from '../src/search/search-provider-error.mjs';
import { selectResearchResumePlan } from '../src/research/resume-plan.mjs';

test('legacy endpoint snapshots rebind current credentials without persisting them', t => {
 const dir = temporary(t), value = settings();
 value.llm = { model: 'fixture-model', provider: 'custom', baseUrl: 'https://name:old-fictional-password@example.test/v1', apiKey: 'old-fictional-key' };
 new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: 'fixture', metadata: { settings: value } });
 const live = globalThis.structuredClone(value);
 live.llm.baseUrl = 'https://name:new-fictional-password@example.test/v1'; live.llm.apiKey = 'new-fictional-key';
 const restored = resolveRunExecutionSettings(live, { sessionDir: dir, checkpoint: { budget: { maxReportOutputTokens: 16000 } } });
 assert.equal(restored.settings.llm.baseUrl, live.llm.baseUrl);
 assert.equal(restored.settings.llm.apiKey, live.llm.apiKey);
 assert.ok(!JSON.stringify(restored.config).includes('fictional'));
});

const settings = () => ({ llm: {}, search: {}, research: { strategy: 'exploratory',
  report: { maxOutputTokens: 16000 }, budget: { maxTotalLlmTokens: 1300000 },
  exploratory: { maxSteps: 8, minLlmTokens: 0, maxLlmTokens: 100000, autoReadTopK: 0 },
  focused: { fetchMode: 'disabled', evidencePassages: { embedding: { enabled: false } } } } });
const search = { async search() { return [{ title: 'Atlas documentation', url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok', contentOrigin: 'provided' }]; } };
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-config-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('resume restores actual report request cap even when current configuration resets it to zero', async t => {
  const dir = temporary(t), initial = settings(), good = canonicalLlm();
  await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: initial, search,
    recorder: new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: '调研 Atlas 这个产品' }),
    llm: { async completeWithMetadata(args) {
      if (args.purpose === 'report') return { text: '', usage: { totalTokens: 100 } };
      return good.completeWithMetadata(args);
    } },
  }), { code: 'REPORT_OUTPUT_INVALID' });
  const current = settings(); current.research.report.maxOutputTokens = 0;
  const calls = [];
  const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings: current,
    recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm({ onCall: args => calls.push(args) }),
    search: { requiresReadinessProbe: true, search: () => assert.fail('report resume cannot search') } });
  assert.equal(calls.find(c => c.purpose === 'report').maxTokens, 16000);
  assert.ok(result.report);
  assert.equal(loadNamedCheckpoint(dir, 'research-start').state.executionConfig.configHash,
    loadNamedCheckpoint(dir, 'research-complete').state.executionConfig.configHash);
});

test('legacy report cap comes from saved ledger, not current defaults or remaining budget', () => {
  const value = settings(); value.research.report.maxOutputTokens = 0;
  const resolved = resolveRunExecutionSettings(value, { checkpoint: { budget: {
    maxReportOutputTokens: 16000, limits: { totalLlmTokens: 1300000 }, usage: { llmTokens: 641307 },
  } } });
  assert.equal(resolved.settings.research.report.maxOutputTokens, 16000);
  assert.equal(resolved.provenance, 'legacy_budget_and_manifest');
  assert.throws(() => createRunExecutionConfig(value), { code: 'INVALID_REPORT_BUDGET_CONFIGURATION' });
  assert.throws(() => resolveRunExecutionSettings({ ...value, llm: { model: 'current-only-model' } }, { checkpoint: { budget: {
    maxReportOutputTokens: 16000, limits: { totalLlmTokens: 1300000 },
  } } }), { code: 'RESUME_CONFIG_UNRESOLVED' });
});

test('snapshot excludes secrets, binds live credentials and rejects changed model identity or corrupted hash', () => {
  const value = settings(); Object.assign(value.llm, { model: 'test-model', apiKey: 'fictional-key', baseUrl: 'https://user:fictional-password@example.test/v1' });
  const config = createRunExecutionConfig(value);
  assert.ok(!JSON.stringify(config).includes('fictional'));
  const live = globalThis.structuredClone(value); live.llm.apiKey = 'new-fictional-key';
  const resolved = resolveRunExecutionSettings(live, { checkpoint: { executionConfig: config } });
  assert.equal(resolved.settings.llm.apiKey, 'new-fictional-key');
  assert.equal(resolved.settings.llm.baseUrl, value.llm.baseUrl);
  live.llm.model = 'other';
  assert.throws(() => resolveRunExecutionSettings(live, { checkpoint: { executionConfig: config } }), { code: 'RESUME_CONFIG_IDENTITY_MISMATCH' });
  config.settings.research.report.maxOutputTokens = 999;
  assert.throws(() => resolveRunExecutionSettings(value, { checkpoint: { executionConfig: config } }), { code: 'RUN_CONFIG_INTEGRITY' });
});

test('failed startup business search resumes original request and budget without overwriting old call receipt', async t => {
  const dir = temporary(t), value = settings();
  await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: value,
    recorder: new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: '调研 Atlas 这个产品' }),
    llm: { complete: () => assert.fail('no planner while search is unavailable') },
    search: { requiresReadinessProbe: true, search: async () => { throw new SearchProviderError('Disconnected'); } },
  }), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
  const original = loadNamedCheckpoint(dir, 'research-start').state.brief.request;
  const receipt = fs.readFileSync(path.join(dir, 'calls/search-1.error.json'));
  const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings: value,
    recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm(), search: { ...search, requiresReadinessProbe: true } });
  assert.equal(result.brief.request.requestId, original.requestId);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'calls/search-1.error.json')), receipt);
  assert.ok(result.quality.budget.usage.searchRequests >= 2);
  assert.ok(fs.existsSync(path.join(dir, 'calls/search-2.response.json')));
});

test('startup resume reuses a persisted LLM response and settles its budget exactly once', async t => {
 const dir = temporary(t), value = settings(), controller = new AbortController();
 const recorder = new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: 'Atlas' });
 const finish = recorder.callFinished.bind(recorder);
 recorder.callFinished = record => {
   const result = finish(record);
   if (record.kind === 'llm' && record.status === 'completed') {
     controller.abort(); controller.signal.throwIfAborted();
   }
   return result;
 };
 await assert.rejects(new ResearchRunner().run({ query: 'Atlas', settings: value, search, recorder,
   llm: canonicalLlm(), signal: controller.signal }), { name: 'AbortError' });
 const responseFile = path.join(dir, 'calls/llm-1.response.json');
 const receipt = fs.readFileSync(responseFile);
 assert.equal(selectResearchResumePlan({ sessionDir: dir }).mode, 'start');
 // A second interruption after rewriting research-start must not move the
 // receipt recovery boundary past the original, still unapplied response.
 await assert.rejects(new ResearchRunner().resumeFromSession({ sessionDir: dir, settings: value,
   recorder: FileRunRecorder.reopen(dir), llm: { complete() { assert.fail('probe failed before planning'); } },
   search: { requiresReadinessProbe: true, async search() { throw new SearchProviderError('fixture outage'); } },
 }), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
 assert.equal(selectResearchResumePlan({ sessionDir: dir }).mode, 'start');
 const purposes = [];
 const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings: value, search: { ...search, requiresReadinessProbe: true },
   recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm({ onCall: args => purposes.push(args.purpose) }) });
 assert.ok(result.report);
 assert.equal(purposes.includes('research_profile'), false);
 assert.deepEqual(fs.readFileSync(responseFile), receipt);
 assert.equal(result.quality.budget.usage.llmTokens, (purposes.length + 1) * 100);
 assert.equal(result.quality.budget.settledAttemptIds.filter(id => id === 'llm-1').length, 1);
 assert.equal(result.quality.budget.reservations.length, 0);
});
