import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FileRunRecorder, saveResearchArtifacts, resolveResearchArtifacts, ResearchRunner } from 'js-deepresearch-engine';
import { migrateDb } from '../src/storage/db.mjs';
import { createServices } from '../src/bootstrap.mjs';
import { completeResearch, recordResearchFailure } from '../src/research-completion.mjs';
import { acquireSessionLock } from '../src/session-lock.mjs';
import { archiveResearchResultSafe } from '../src/storage/intel-store.mjs';
import { runCliResearchResume } from '../src/cli-research-run.mjs';
import { EventEmitter } from 'node:events';
import { loadArtifacts } from '../scripts/benchmark/load-artifacts.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { archiveResearchResult, createIntelStoreEngine, readArchivedResearch } from '../src/storage/intel-store.mjs';
import { loadSourcesFromIntelStore } from 'js-wiki-engine';
import { listArchivedSources } from '../scripts/intel/inspect-core.mjs';

function fixture(t) {
  const db = migrateDb(new Database(':memory:'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-completion-'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const services = createServices(db);
  services.researchRepository.create({ id: 'run', query: 'query', strategy: 'quick' });
  const result = { resultRevision: 'first', report: '# Valid report', sources: [{ url: 'https://example.com/a' }], findings: [], quality: { gate: 'pass' } };
  const options = {
    id: 'run', result, query: 'query', strategy: 'quick', settings: { research: {} }, sessionDir: dir,
    services, saveArtifacts: saveResearchArtifacts, archive: async () => ({ ok: true }),
  };
  return { ...options, options, db, dir };
}

test('post-commit export, recorder and notification failures cannot undo completion', async (t) => {
  const f = fixture(t);
  const outcome = await completeResearch({ ...f.options,
    recorder: { finalize() { throw new Error('private provider payload'); } },
    output: 'target', writeFile() { throw Object.assign(new Error('secret'), { code: 'EACCES' }); },
    onStatus() { throw new Error('SSE disconnected'); },
    onWarning() { throw new Error('log failed'); },
  });
  const record = f.services.researchRepository.get('run');
  assert.equal(record.status, 'completed');
  assert.equal(record.report, f.result.report);
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.delivery.failures.map((x) => x.stage), ['recorder', 'output', 'notification']);
  assert.doesNotMatch(JSON.stringify(record.delivery), /secret|private|payload/);
  assert.equal(resolveResearchArtifacts(f.dir).resultRevision, 'first');
});

test('failed recorder cleanup still updates history and preserves primary error', (t) => {
  const f = fixture(t);
  const error = new Error('primary report failure');
  const failures = recordResearchFailure({ id: 'run', repository: f.services.researchRepository, error,
    recorder: { finalize() { throw new Error('disk full'); } } });
  assert.equal(f.services.researchRepository.get('run').error, error.message);
  assert.equal(failures[0].stage, 'recorder');
});

test('database commit failure does not publish a prepared version', async (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_status BEFORE UPDATE OF status ON research_history BEGIN SELECT RAISE(ABORT,'database unavailable'); END");
  await assert.rejects(completeResearch(f.options), /database unavailable/);
  assert.equal(fs.existsSync(path.join(f.dir, 'result-current.json')), false);
  assert.equal(f.services.sourceRepository.list('run').length, 0);
});

test('archive warning callback cannot escape the safe archive boundary', async () => {
  const result = await archiveResearchResultSafe({ researchId: 'run', engine: { ingest() { throw new Error('disk'); } } }, {
    onWarning() { throw new Error('notification'); },
  });
  assert.equal(result.ok, false);
});

test('final checkpoint restoration makes no LLM or search calls and reuses revision', async (t) => {
  const f = fixture(t);
  const recorder = new FileRunRecorder({ sessionDir: f.dir, runId: 'run', query: 'query', strategy: 'quick' });
  recorder.checkpoint('research-complete', { result: f.result });
  const runner = new ResearchRunner();
  const resumed = await runner.resumeFromSession({ sessionDir: f.dir, settings: {},
    llm: { chat() { throw new Error('must not call LLM'); } },
    search: { search() { throw new Error('must not search'); } },
  });
  assert.deepEqual(resumed, f.result);
  await completeResearch({ ...f.options, result: resumed });
  const id = f.services.sourceRepository.list('run')[0].id;
  await completeResearch({ ...f.options, result: resumed });
  assert.equal(f.services.sourceRepository.list('run')[0].id, id);
  assert.equal(fs.readdirSync(path.join(f.dir, 'results')).length, 1);
});

test('session lock prevents concurrent writers and releases cleanly', (t) => {
  const f = fixture(t);
  const release = acquireSessionLock(f.dir);
  assert.throws(() => acquireSessionLock(f.dir), { code: 'SESSION_BUSY' });
  release();
  acquireSessionLock(f.dir)();
});

test('a terminated writer releases its session lock without stale-file cleanup', async (t) => {
  const f = fixture(t);
  const url = new URL('../src/session-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireSessionLock } from ${JSON.stringify(url)}; const release = acquireSessionLock(process.argv[1]); process.stdout.write('ready'); setInterval(() => void release, 1000);`, f.dir]);
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.throws(() => acquireSessionLock(f.dir), { code: 'SESSION_BUSY' });
  child.kill('SIGKILL');
  await once(child, 'exit');
  acquireSessionLock(f.dir)();
});

test('delivery retry preserves completion timestamp and skips an already successful archive', async (t) => {
  const f = fixture(t);
  let archives = 0;
  const options = { ...f.options, archive: async () => { archives += 1; return { ok: true }; } };
  await completeResearch(options);
  const completedAt = f.services.researchRepository.get('run').completedAt;
  f.db.exec("CREATE TRIGGER no_recommit BEFORE UPDATE OF status ON research_history BEGIN SELECT RAISE(ABORT,'must not recommit'); END");
  fs.unlinkSync(path.join(f.dir, 'result-current.json'));
  await completeResearch(options);
  assert.equal(archives, 1);
  assert.equal(f.services.researchRepository.get('run').completedAt, completedAt);
  assert.equal(resolveResearchArtifacts(f.dir).resultRevision, 'first');
});

test('failed recorder reopen during delivery-only resume preserves completed history', async (t) => {
  const f = fixture(t);
  const recorder = new FileRunRecorder({ sessionDir: f.dir, runId: 'run', query: 'query', strategy: 'quick' });
  recorder.checkpoint('research-complete', { result: f.result });
  await completeResearch({ ...f.options, recorder });
  await assert.rejects(runCliResearchResume({
    sessionDir: f.dir, settings: f.options.settings, flags: {}, services: f.services,
    signalTarget: new EventEmitter(), createRecorder() { throw new Error('recorder unavailable'); },
  }), /recorder unavailable/);
  assert.equal(f.services.researchRepository.get('run').status, 'completed');
});

test('benchmark reads a consistent published revision instead of compatibility files', async (t) => {
  const f = fixture(t);
  await completeResearch(f.options);
  fs.writeFileSync(path.join(f.dir, 'sources.json'), 'corrupted mirror');
  fs.writeFileSync(path.join(f.dir, 'report.md'), '# Incorrect');
  const loaded = loadArtifacts(f.dir);
  assert.equal(loaded.report, f.result.report);
  assert.deepEqual(loaded.sources, f.result.sources);
});

test('no-save, no-work-dir and cancellation keep their persistence boundaries', async (t) => {
  const f = fixture(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(completeResearch({ ...f.options, signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(f.dir, 'results')), false);
  const transient = await completeResearch({ ...f.options, id: null, sessionDir: null,
    output: 'missing', writeFile() { throw new Error('cannot write'); },
  });
  assert.equal(transient.exitCode, 1);
  assert.equal(transient.artifacts, null);
  assert.equal(fs.existsSync(path.join(f.dir, 'results')), false);
  const saved = await completeResearch({ ...f.options, id: null });
  assert.equal(saved.exitCode, 0);
  assert.equal(resolveResearchArtifacts(f.dir).resultRevision, 'first');
  assert.equal(f.services.researchRepository.get('run').status, 'queued');
});

test('Web completion survives broken logging and SSE delivery', async (t) => {
  const f = fixture(t);
  const runner = f.services.jobRunner;
  runner.runner = { run: async () => f.result };
  runner.logRepository = { add() { throw new Error('log unavailable'); } };
  runner.eventBus = { emit() { throw new Error('SSE disconnected'); } };
  // Isolate the archive too; a Web job must never write to a user's default intel store.
  const previous = process.env.JDR_INTEL_STORE_DIR;
  process.env.JDR_INTEL_STORE_DIR = path.join(f.dir, 'intel');
  const { resetIntelStoreEngine } = await import('../src/storage/intel-store.mjs');
  resetIntelStoreEngine();
  t.after(() => {
    if (previous === undefined) delete process.env.JDR_INTEL_STORE_DIR;
    else process.env.JDR_INTEL_STORE_DIR = previous;
    resetIntelStoreEngine();
  });
  await runner.runJob({ id: 'run', query: 'query', settings: { research: { strategy: 'quick' } },
    sessionDir: f.dir, controller: new AbortController(),
  });
  const record = f.services.researchRepository.get('run');
  assert.equal(record.status, 'completed');
  assert.ok(record.delivery.failures.some((item) => item.stage === 'notification'));
});

test('archive readers use whole revisions even when a later archive fails before publication', (t) => {
  const f = fixture(t);
  const engine = createIntelStoreEngine({ baseDir: path.join(f.dir, 'intel') });
  const args = { researchId: 'run', query: 'query', strategy: 'quick', engine, result: f.result };
  archiveResearchResult(args);
  const next = { ...f.result, resultRevision: 'second', report: '# Second', sources: [] };
  const ingest = engine.ingest.bind(engine);
  engine.ingest = (name, records) => {
    if (name === 'research_runs') throw new Error('publish failed');
    return ingest(name, records);
  };
  assert.throws(() => archiveResearchResult({ ...args, result: next }), /publish failed/);
  assert.equal(readArchivedResearch('run', engine).report, f.result.report);
  assert.equal(loadSourcesFromIntelStore({ researchId: 'run', engine }).sources.length, 1);
  engine.ingest = ingest;
  archiveResearchResult({ ...args, result: next });
  assert.equal(readArchivedResearch('run', engine).report, '# Second');
  assert.equal(listArchivedSources('run', engine).length, 0);
  assert.equal(loadSourcesFromIntelStore({ researchId: 'run', engine }).sources.length, 0);
});

test('canonical intel and Wiki readers resolve archived bodies without the original session', async (t) => {
  const { EvidenceStore } = await import('js-deepresearch-engine');
  const f = fixture(t);
  const engine = createIntelStoreEngine({ baseDir: path.join(f.dir, 'intel') });
  const store = new EvidenceStore();
  const version = store.register({ url: 'https://example.org/tool', content: 'The publisher says the tool processes local documents under a permissive license.', fetchStatus: 'ok' });
  const passage = store.chunks(version.documentVersionId)[0];
  const result = { ...f.result, evidenceStore: store.export(), evidenceAppendix: '# Evidence',
    sources: [{ id: version.sourceId, url: version.url, title: 'Tool' }], passages: [passage],
    citationRegistry: { schemaVersion: 1, entries: [{ citationKey: '4.1', sourceId: version.sourceId, documentVersionId: version.documentVersionId, passageIds: [passage.id], url: version.url }] } };
  archiveResearchResult({ researchId: 'run', query: 'tool', strategy: 'focused', engine, result, artifacts: { sessionDir: path.join(f.dir, 'absent-session') } });
  const archived = readArchivedResearch('run', engine);
  const wiki = loadSourcesFromIntelStore({ researchId: 'run', engine });
  assert.equal(new EvidenceStore(archived.evidenceStore).body(version.documentVersionId), store.body(version.documentVersionId));
  assert.deepEqual(wiki.citationRegistry, result.citationRegistry);
  assert.equal(new EvidenceStore(wiki.evidenceStore).passages.get(passage.id).text, passage.text);
});
