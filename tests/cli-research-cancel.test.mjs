import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { FileRunRecorder } from 'js-deepresearch-engine';
import {
  ResearchCancelledError,
  createResearchAbortController,
  runCliResearch,
  runCliResearchResume,
} from '../src/cli-research-run.mjs';
import { resetIntelStoreEngine } from '../src/storage/intel-store.mjs';
import { migrateDb, closeDb } from '../src/storage/db.mjs';
import Database from 'better-sqlite3';
import { ResearchRepository } from '../src/storage/research-repository.mjs';
import { SourceRepository } from '../src/storage/source-repository.mjs';

const noopProbe = async () => ({ ok: true });

describe('CLI research cancellation', () => {
  const tempDirs = [];

  afterEach(() => {
    delete process.env.JDR_INTEL_STORE_DIR;
    resetIntelStoreEngine();
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function isolateIntelStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-cli-intel-'));
    tempDirs.push(dir);
    process.env.JDR_INTEL_STORE_DIR = path.join(dir, 'intel');
  }

  function makeWorkRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-cli-work-'));
    tempDirs.push(dir);
    return dir;
  }

  it('marks history as cancelled when runner aborts', async () => {
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    const abortError = new Error('Research aborted');
    abortError.name = 'AbortError';
    const workDir = makeWorkRoot();

    await assert.rejects(
      () => runCliResearch({
        query: 'deep research',
        settings: { research: { strategy: 'quick', workDir } },
        flags: {},
        services: { researchRepository, sourceRepository },
        runner: {
          run: async ({ signal }) => {
            signal?.throwIfAborted?.();
            throw abortError;
          },
        },
        cryptoRandomId: () => 'test-cancel-id',
        probeSearch: noopProbe,
        signalTarget: new EventEmitter(),
      }),
      ResearchCancelledError,
    );

    const record = researchRepository.get('test-cancel-id');
    assert.equal(record.status, 'cancelled');
    assert.match(record.error, /Research aborted/);
    const session = fs.readdirSync(path.join(workDir, 'quick'))[0];
    const sessionDir = path.join(workDir, 'quick', session);
    const run = JSON.parse(fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8'));
    assert.equal(run.status, 'cancelled');
    assert.equal(record.sessionDir, sessionDir);
    assert.equal(fs.existsSync(path.join(sessionDir, 'failure.json')), true);
    db.close();
  });

  it('marks history as running before completion', async () => {
    isolateIntelStore();
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    let observedStatus = null;
    const progressLogs = [];

    await runCliResearch({
      query: 'hello',
      settings: { research: { strategy: 'quick' } },
      flags: { json: true, 'no-work-dir': true },
      services: { researchRepository, sourceRepository },
      runner: {
        run: async () => {
          observedStatus = researchRepository.get('test-running-id')?.status;
          return {
            report: '# Report',
            findings: [],
            sources: [{ title: 'A', url: 'https://example.com', snippet: 'A' }],
            quality: { gate: 'pass', qualityMetricsVersion: 2 },
          };
        },
      },
      cryptoRandomId: () => 'test-running-id',
      probeSearch: noopProbe,
      signalTarget: new EventEmitter(),
      onProgressLog: (...entry) => progressLogs.push(entry),
    });

    assert.equal(observedStatus, 'running');
    assert.equal(researchRepository.get('test-running-id').status, 'completed');
    assert.deepEqual(researchRepository.get('test-running-id').quality, {
      gate: 'pass',
      qualityMetricsVersion: 2,
    });
    assert.ok(progressLogs.length === 0, 'the injected runner emitted no progress in this fixture');
    db.close();
  });

  it('keeps JSON stdout compatible while sending progress to stderr callbacks', async () => {
    isolateIntelStore();
    const db = createTestDb();
    const logs = [];
    await runCliResearch({
      query: 'observable run',
      settings: { research: { strategy: 'quick' } },
      flags: { json: true, 'no-save': true, 'no-work-dir': true },
      services: { researchRepository: new ResearchRepository(db), sourceRepository: new SourceRepository(db) },
      runner: {
        run: async ({ onProgress }) => {
          onProgress({ level: 'info', progress: null, message: 'LLM call started: report' });
          return { report: '# Report', findings: [], sources: [], quality: { gate: 'pass' } };
        },
      },
      createSessionDir: () => {
        throw new Error('--no-work-dir must not create a session');
      },
      probeSearch: noopProbe,
      signalTarget: new EventEmitter(),
      onProgressLog: (...entry) => logs.push(entry),
    });
    assert.deepEqual(logs, [['info', null, 'LLM call started: report']]);
    db.close();
  });

  it('marks invalid report generation as failed, preserves the session, and writes no final artifacts', async () => {
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    let artifactWrites = 0;
    const error = new Error('Report generation produced no usable report');
    error.name = 'ReportGenerationError';
    error.code = 'REPORT_OUTPUT_INVALID';
    const workDir = makeWorkRoot();
    await assert.rejects(() => runCliResearch({
      query: 'empty report',
      settings: { research: { strategy: 'focused', workDir } },
      flags: {},
      services: { researchRepository, sourceRepository: new SourceRepository(db) },
      runner: { run: async () => { throw error; } },
      saveArtifacts: () => { artifactWrites += 1; },
      cryptoRandomId: () => 'invalid-report-id',
      probeSearch: noopProbe,
      signalTarget: new EventEmitter(),
    }), /no usable report/);
    assert.equal(artifactWrites, 0);
    assert.equal(researchRepository.get('invalid-report-id').status, 'failed');
    assert.equal(researchRepository.get('invalid-report-id').error, error.message);
    const session = fs.readdirSync(path.join(workDir, 'focused'))[0];
    const sessionDir = path.join(workDir, 'focused', session);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8')).status, 'failed');
    assert.equal(fs.existsSync(path.join(sessionDir, 'failure.json')), true);
    assert.equal(fs.existsSync(path.join(sessionDir, 'report.md')), false);
    db.close();
  });

  it('aborts on first signal and allows second signal to force exit', () => {
    const signalTarget = new EventEmitter();
    let exitCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      exitCode = code;
    };

    try {
      const { controller, install, remove } = createResearchAbortController({ signalTarget });
      install();
      signalTarget.emit('SIGINT');
      assert.equal(controller.signal.aborted, true);
      signalTarget.emit('SIGINT');
      assert.equal(exitCode, 130);
      remove();
    } finally {
      process.exit = originalExit;
    }
  });

  it('resumes a failed history row into the same session directory', async () => {
    isolateIntelStore();
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    const workDir = makeWorkRoot();
    const sessionDir = path.join(workDir, 'exploratory', '2026-09-07_050524');
    const seed = new FileRunRecorder({
      sessionDir,
      runId: 'resume-id',
      strategy: 'exploratory',
      query: 'qwen hardware',
    });
    seed.checkpoint('pre-report', { query: 'qwen hardware' });
    seed.finalize('failed', { error: new Error('headers timeout') });
    researchRepository.create({
      id: 'resume-id',
      query: 'qwen hardware',
      strategy: 'exploratory',
    });
    researchRepository.updateStatus('resume-id', 'failed', {
      error: 'headers timeout',
      sessionDir,
      completedAt: new Date().toISOString(),
    });

    await runCliResearchResume({
      sessionDir,
      settings: { research: { strategy: 'exploratory', workDir }, search: {} },
      flags: {},
      services: { researchRepository, sourceRepository },
      runner: {
        resumeFromSession: async ({ sessionDir: resumedDir }) => {
          assert.equal(resumedDir, sessionDir);
          return {
            report: '# Resumed report\n',
            sources: [],
            findings: [],
            gaps: [],
            quality: { gate: 'pass' },
          };
        },
      },
      signalTarget: new EventEmitter(),
    });

    const record = researchRepository.get('resume-id');
    assert.equal(record.status, 'completed');
    assert.equal(record.error, null);
    assert.equal(record.sessionDir, sessionDir);
    assert.equal(fs.existsSync(path.join(sessionDir, 'report.md')), true);
    assert.equal(fs.existsSync(path.join(sessionDir, 'failure.json')), false);
    const run = JSON.parse(fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8'));
    assert.equal(run.status, 'completed');
    db.close();
  });

  it('rejects --continue-explore without extra steps before calling the runner', async () => {
    const workDir = makeWorkRoot();
    const sessionDir = path.join(workDir, 'exploratory', '2026-09-07_050524');
    const seed = new FileRunRecorder({
      sessionDir,
      runId: 'continue-id',
      strategy: 'exploratory',
      query: 'qwen hardware',
    });
    seed.checkpoint('pre-report', { query: 'qwen hardware' });
    seed.finalize('failed', { error: new Error('headers timeout') });
    let called = false;
    await assert.rejects(
      () => runCliResearchResume({
        sessionDir,
        settings: { research: { strategy: 'exploratory', workDir }, search: {} },
        flags: { 'continue-explore': true },
        services: {
          researchRepository: { get() { return null; }, create() {}, updateStatus() {} },
          sourceRepository: { addMany() {} },
        },
        runner: {
          resumeFromSession: async () => {
            called = true;
            return { report: '# no', sources: [], findings: [], quality: {} };
          },
        },
        probeSearch: noopProbe,
        signalTarget: new EventEmitter(),
      }),
      /--continue-explore requires --resume-extra-steps/,
    );
    assert.equal(called, false);
  });

  it('resumes an unfinished exploratory step without continue-explore', async () => {
    const workDir = makeWorkRoot();
    const sessionDir = path.join(workDir, 'exploratory', '2026-09-07_051000');
    const seed = new FileRunRecorder({
      sessionDir,
      runId: 'mid-loop-id',
      strategy: 'exploratory',
      query: 'qwen hardware',
      metadata: { settings: { search: { engine: 'js-eyes' } } },
    });
    seed.checkpoint('exploratory-step-complete', {
      query: 'qwen hardware',
      step: 2,
      loopLocal: { consecutiveInvalidSteps: 1 },
    });
    let seen = null;
    await runCliResearchResume({
      sessionDir,
      settings: { research: { strategy: 'exploratory', workDir }, search: { engine: 'js-eyes' } },
      flags: {},
      services: {
        researchRepository: { get() { return null; }, create() {}, updateStatus() {} },
        sourceRepository: { addMany() {} },
      },
      runner: {
        resumeFromSession: async (args) => {
          seen = args;
          return { report: '# Mid\n', sources: [], findings: [], quality: { gate: 'pass' } };
        },
      },
      probeSearch: noopProbe,
      signalTarget: new EventEmitter(),
    });
    assert.equal(seen.continueExplore, false);
    assert.equal(seen.sessionDir, sessionDir);
  });
});

function createTestDb() {
  const db = new Database(':memory:');
  migrateDb(db);
  return db;
}
