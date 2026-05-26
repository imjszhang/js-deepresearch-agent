import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  DataSourceRegistry,
  DataSourceSpec,
  StorageEngine,
} from 'js-intel-store';
import { loadSourcesFromIntelStore } from '../src/source-adapters/intel-store.mjs';

function createTestEngine(baseDir) {
  const registry = new DataSourceRegistry().registerAll([
    new DataSourceSpec({ name: 'research_runs', storageType: 'entity_json' }),
    new DataSourceSpec({ name: 'research_findings', storageType: 'entity_jsonl' }),
    new DataSourceSpec({ name: 'research_sources', storageType: 'entity_jsonl', dedupKey: 'dedup_id' }),
    new DataSourceSpec({ name: 'research_reports', storageType: 'entity_json' }),
  ]);
  return new StorageEngine({ baseDir, registry, timezone: 'UTC' });
}

describe('intel-store adapter', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads normalized sources from archived intel records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-intel-adapter-'));
    tempDirs.push(root);

    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const reportPath = path.join(sessionDir, 'report.md');
    fs.writeFileSync(reportPath, '# Report\n\n## Claims\n\n- Example claim with sufficient length here.\n', 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'sources.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'findings.json'), '[]', 'utf8');

    const engine = createTestEngine(path.join(root, 'intel'));
    const researchId = 'adapter-run-1';
    const now = new Date().toISOString();

    engine.ingest('research_runs', {
      name: researchId,
      query: 'llm wiki',
      strategy: 'source-based',
      status: 'completed',
      sessionDir,
      reportPath,
      archivedAt: now,
    });

    engine.ingest('research_reports', {
      name: researchId,
      report: '# Inline Report\n\n## Claims\n\n- Example claim with sufficient length here.\n',
      reportPath,
      reportLength: 40,
      sessionDir,
      archivedAt: now,
    });

    engine.ingest('research_sources', {
      _entity_id: researchId,
      dedup_id: 'https://example.com/a',
      title: 'Example',
      url: 'https://example.com/a',
      snippet: 'snippet text',
      engine: 'test',
    });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    assert.equal(loaded.researchId, researchId);
    assert.equal(loaded.sources.length, 1);
    assert.equal(loaded.sources[0].title, 'Example');
    assert.match(loaded.report, /Example claim/);
    assert.equal(loaded.meta.query, 'llm wiki');
  });

  it('prefers inline report over missing reportPath file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-intel-inline-'));
    tempDirs.push(root);

    const engine = createTestEngine(path.join(root, 'intel'));
    const researchId = 'inline-report-run';

    engine.ingest('research_runs', {
      name: researchId,
      query: 'inline',
      strategy: 'rapid',
      status: 'completed',
      sessionDir: path.join(root, 'missing-session'),
      reportPath: path.join(root, 'missing-session', 'report.md'),
      archivedAt: new Date().toISOString(),
    });

    engine.ingest('research_reports', {
      name: researchId,
      report: '# Inline Only\n\nPortable report body.',
      reportPath: path.join(root, 'missing-session', 'report.md'),
      reportLength: 30,
      archivedAt: new Date().toISOString(),
    });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    assert.equal(loaded.report, '# Inline Only\n\nPortable report body.');
  });

  it('uses stable sourceIndex from archived records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-intel-index-'));
    tempDirs.push(root);

    const engine = createTestEngine(path.join(root, 'intel'));
    const researchId = 'indexed-run';

    engine.ingest('research_runs', {
      name: researchId,
      query: 'indexed',
      strategy: 'source-based',
      status: 'completed',
      archivedAt: new Date().toISOString(),
    });

    engine.ingest('research_reports', {
      name: researchId,
      report: '# Report',
      reportLength: 8,
      archivedAt: new Date().toISOString(),
    });

    engine.ingest('research_sources', {
      _entity_id: researchId,
      dedup_id: 'https://example.com/b',
      sourceIndex: 2,
      title: 'Second',
      url: 'https://example.com/b',
      snippet: 'b',
      fetchStatus: 'ok',
      hasContent: true,
      contentLength: 12,
    });

    engine.ingest('research_sources', {
      _entity_id: researchId,
      dedup_id: 'https://example.com/a',
      sourceIndex: 1,
      title: 'First',
      url: 'https://example.com/a',
      snippet: 'a',
      fetchStatus: 'failed',
      fetchError: 'timeout',
      hasContent: false,
      contentLength: 0,
    });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    assert.equal(loaded.sources.length, 2);
    assert.equal(loaded.sources[0].title, 'First');
    assert.equal(loaded.sources[0].sourceIndex, 1);
    assert.equal(loaded.sources[0].fetchStatus, 'failed');
    assert.equal(loaded.sources[1].title, 'Second');
    assert.equal(loaded.sources[1].sourceIndex, 2);
  });

  it('throws when research run is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-intel-missing-'));
    tempDirs.push(root);
    const engine = createTestEngine(path.join(root, 'intel'));

    assert.throws(
      () => loadSourcesFromIntelStore({ engine, researchId: 'missing' }),
      /not found/,
    );
  });
});
