import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildImportedResearchId,
  resolveResearchId,
  discoverWorkDirSessions,
  importWorkDirSessions,
} from '../scripts/intel/import-work-dir-core.mjs';
import {
  ARCHIVE_SCHEMA_VERSION,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';

describe('intel store import', () => {
  const tempDirs = [];

  afterEach(() => {
    resetIntelStoreEngine();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-intel-import-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeSession(root, strategy, timestamp, { researchId = null } = {}) {
    const sessionDir = path.join(root, strategy, timestamp);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'report.md'), '# Report\n\nClaim [1.1].', 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'findings.json'), JSON.stringify([
      { question: 'q1', sources: [{ title: 'A', url: 'https://a.test', snippet: 'alpha' }] },
    ], null, 2), 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'sources.json'), JSON.stringify([
      { title: 'A', url: 'https://a.test', snippet: 'alpha' },
    ], null, 2), 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      query: 'test query',
      strategy,
      researchId,
      createdAt: '2026-05-26T00:00:00.000Z',
      settings: { iterations: 1 },
    }, null, 2), 'utf8');
    return sessionDir;
  }

  it('builds stable imported research ids', () => {
    assert.equal(
      buildImportedResearchId('source-based', '2026-05-26_065414'),
      'imported__source-based__2026-05-26_065414',
    );
    assert.equal(
      resolveResearchId({ researchId: 'uuid-1' }, 'rapid', '2026-05-26_070000'),
      'uuid-1',
    );
    assert.equal(
      resolveResearchId({}, 'source-based', '2026-05-26_065414'),
      'imported__source-based__2026-05-26_065414',
    );
  });

  it('discovers complete and incomplete sessions', () => {
    const root = makeTempRoot();
    writeSession(root, 'source-based', '2026-05-26_065414');
    const brokenDir = path.join(root, 'rapid', '2026-05-26_070000');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'report.md'), '# only report', 'utf8');

    const sessions = discoverWorkDirSessions({ root });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].timestamp, '2026-05-26_070000');
    assert.equal(sessions[1].timestamp, '2026-05-26_065414');
  });

  it('imports complete sessions and skips broken or existing runs', () => {
    const root = makeTempRoot();
    const intelDir = path.join(root, 'intel');
    const workRoot = path.join(root, 'work_dir');

    writeSession(workRoot, 'source-based', '2026-05-26_065414');
    writeSession(workRoot, 'source-based', '2026-05-26_070000', { researchId: 'existing-id' });
    fs.mkdirSync(path.join(workRoot, 'rapid', '2026-05-26_080000'), { recursive: true });

    const engine = createIntelStoreEngine({ baseDir: intelDir });
    engine.ingest('research_runs', {
      name: 'existing-id',
      query: 'old',
      strategy: 'source-based',
      status: 'completed',
    });

    const summary = importWorkDirSessions({ root: workRoot, engine });
    assert.equal(summary.imported, 1);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 0);

    const imported = engine.readSource('research_runs', {
      name: 'imported__source-based__2026-05-26_065414',
    });
    assert.equal(imported.query, 'test query');
    assert.equal(imported.sourcesCount, 1);

    const dryRun = importWorkDirSessions({ root: workRoot, engine, dryRun: true, skipExisting: false });
    assert.equal(dryRun.imported, 0);
    assert.equal(dryRun.upgraded, 2);
    assert.equal(dryRun.items.filter((item) => item.status === 'dry-run-upgrade').length, 2);
  });

  it('upgrades existing archived runs from work_dir when upgradeExisting is true', () => {
    const root = makeTempRoot();
    const intelDir = path.join(root, 'intel');
    const workRoot = path.join(root, 'work_dir');
    const researchId = 'existing-id';

    writeSession(workRoot, 'source-based', '2026-05-26_070000', { researchId });

    const engine = createIntelStoreEngine({ baseDir: intelDir });
    engine.ingest('research_runs', {
      name: researchId,
      query: 'old query',
      strategy: 'source-based',
      status: 'completed',
      archiveSchemaVersion: 1,
    });
    engine.ingest('research_reports', {
      name: researchId,
      reportPath: path.join(workRoot, 'source-based', '2026-05-26_070000', 'report.md'),
      reportLength: 0,
    });

    const skipped = importWorkDirSessions({ root: workRoot, engine, upgradeExisting: false });
    assert.equal(skipped.skipped, 1);
    assert.equal(skipped.upgraded, 0);

    const upgraded = importWorkDirSessions({ root: workRoot, engine, upgradeExisting: true });
    assert.equal(upgraded.upgraded, 1);
    assert.equal(upgraded.imported, 0);

    const run = engine.readSource('research_runs', { name: researchId });
    assert.equal(run.query, 'test query');
    assert.equal(run.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION);

    const reportMeta = engine.readSource('research_reports', { name: researchId });
    assert.match(reportMeta.report, /Claim \[1\.1\]/);

    const sources = engine.readSource('research_sources', { entity_id: researchId });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].sourceIndex, 1);
  });
});
