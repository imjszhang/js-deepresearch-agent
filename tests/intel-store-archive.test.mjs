import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  archiveResearchResult,
  archiveResearchResultSafe,
  ARCHIVE_SCHEMA_VERSION,
  createIntelStoreEngine,
  loadArtifactsByResearchId,
  readArchivedResearch,
  resetIntelStoreEngine,
  sourceDedupId,
} from '../src/storage/intel-store.mjs';

describe('intel store archive', () => {
  const tempDirs = [];

  afterEach(() => {
    resetIntelStoreEngine();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-intel-store-'));
    tempDirs.push(dir);
    return dir;
  }

  it('archives run, findings, sources, and report metadata', () => {
    const baseDir = makeTempRoot();
    const sessionDir = path.join(baseDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const reportPath = path.join(sessionDir, 'report.md');
    fs.writeFileSync(reportPath, '# Report\n\nDone.', 'utf8');

    const engine = createIntelStoreEngine({ baseDir: path.join(baseDir, 'intel') });
    const result = archiveResearchResult({
      researchId: 'run-1',
      query: 'What is LLM Wiki?',
      strategy: 'source-based',
      result: {
        report: '# Report\n\nDone.',
        findings: [{ question: 'Q1', iteration: 1, sources: [{ title: 'A', url: 'https://a.test' }] }],
        sources: [
          { title: 'A', url: 'https://a.test', snippet: 'one' },
          { title: 'B', url: 'https://a.test', snippet: 'dup' },
          { title: 'C', url: '', snippet: 'no url' },
        ],
      },
      artifacts: {
        sessionDir,
        reportPath,
        findingsPath: path.join(sessionDir, 'findings.json'),
        sourcesPath: path.join(sessionDir, 'sources.json'),
        metaPath: path.join(sessionDir, 'meta.json'),
      },
      settings: { research: { iterations: 2, questionsPerIteration: 3, concurrency: 1 } },
      engine,
    });

    assert.equal(result.ok, true);

    const run = engine.readSource('research_runs', { name: 'run-1' });
    assert.equal(run.query, 'What is LLM Wiki?');
    assert.equal(run.strategy, 'source-based');
    assert.equal(run.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION);
    assert.equal(run.findingsCount, 1);
    assert.equal(run.sourcesCount, 3);
    assert.equal(run.reportPath, reportPath);

    const findings = engine.readSource('research_findings', { entity_id: 'run-1' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].question, 'Q1');

    const sources = engine.readSource('research_sources', { entity_id: 'run-1' });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].sourceIndex, 1);
    assert.equal(sources[1].sourceIndex, 3);
    assert.equal(sources[0].hasContent, false);

    const reportMeta = engine.readSource('research_reports', { name: 'run-1' });
    assert.equal(reportMeta.report, '# Report\n\nDone.');

    const loaded = loadArtifactsByResearchId('run-1', { engine });
    assert.equal(loaded.meta.researchId, 'run-1');
    assert.equal(loaded.findings.length, 1);
    assert.equal(loaded.sources.length, 2);
    assert.equal(loaded.report, '# Report\n\nDone.');
  });

  it('loads inline report when work_dir report file is missing', () => {
    const baseDir = makeTempRoot();
    const engine = createIntelStoreEngine({ baseDir: path.join(baseDir, 'intel') });

    archiveResearchResult({
      researchId: 'portable-run',
      query: 'portable intel',
      strategy: 'rapid',
      result: {
        report: '# Portable\n\nInline report body.',
        findings: [],
        sources: [{ title: 'S', url: 'https://portable.test', snippet: 'x' }],
      },
      artifacts: {
        sessionDir: path.join(baseDir, 'missing-session'),
        reportPath: path.join(baseDir, 'missing-session', 'report.md'),
      },
      engine,
    });

    const loaded = readArchivedResearch('portable-run', engine);
    assert.equal(loaded.report, '# Portable\n\nInline report body.');
  });

  it('sourceDedupId falls back to content hash then unknown index', () => {
    assert.equal(sourceDedupId({ url: 'https://x.test' }), 'https://x.test');
    assert.equal(
      sourceDedupId({ title: 'T', snippet: 'S' }),
      crypto.createHash('sha256').update('T:S:').digest('hex'),
    );
    assert.equal(sourceDedupId({}, 4), 'unknown-4');
  });

  it('archiveResearchResultSafe returns error without throwing', async () => {
    const brokenEngine = {
      ingest() {
        throw new Error('disk full');
      },
    };

    const warnings = [];
    const outcome = await archiveResearchResultSafe({
      researchId: 'run-broken',
      query: 'q',
      strategy: 'rapid',
      result: { report: '', findings: [], sources: [] },
      engine: brokenEngine,
    }, {
      onWarning: (message) => warnings.push(message),
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'disk full');
    assert.deepEqual(warnings, ['disk full']);
  });

  it('skips archive when researchId is missing', () => {
    const baseDir = makeTempRoot();
    const engine = createIntelStoreEngine({ baseDir: path.join(baseDir, 'intel') });
    const outcome = archiveResearchResult({
      researchId: null,
      query: 'q',
      strategy: 'rapid',
      result: { report: '', findings: [], sources: [] },
      engine,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'missing researchId');
    assert.throws(
      () => readArchivedResearch('missing', engine),
      /Archived research run not found/,
    );
  });
});
