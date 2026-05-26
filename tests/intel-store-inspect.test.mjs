import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  listArchivedRuns,
  showArchivedRun,
  listArchivedSources,
  listArchivedFindings,
} from '../scripts/intel/inspect-core.mjs';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';

describe('intel store inspect', () => {
  const tempDirs = [];

  afterEach(() => {
    resetIntelStoreEngine();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedEngine() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-intel-inspect-'));
    tempDirs.push(root);
    const engine = createIntelStoreEngine({ baseDir: path.join(root, 'intel') });
    archiveResearchResult({
      researchId: 'inspect-run-1',
      query: 'llm wiki',
      strategy: 'source-based',
      result: {
        report: '# Report',
        findings: [{ question: 'q1', iteration: 1, sources: [{ title: 'A', url: 'https://a.test' }] }],
        sources: [{ title: 'A', url: 'https://a.test', snippet: 'alpha', engine: 'test' }],
      },
      artifacts: { sessionDir: '/tmp/session' },
      engine,
    });
    return engine;
  }

  it('lists archived runs', () => {
    const engine = seedEngine();
    const runs = listArchivedRuns(engine);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].researchId, 'inspect-run-1');
    assert.equal(runs[0].sourcesCount, 1);
  });

  it('shows run details and child records', () => {
    const engine = seedEngine();
    const run = showArchivedRun('inspect-run-1', engine);
    assert.equal(run.query, 'llm wiki');
    assert.equal(run.findingsCount, 1);
    assert.equal(run.sourcesCount, 1);

    const sources = listArchivedSources('inspect-run-1', engine);
    assert.equal(sources[0].url, 'https://a.test');

    const findings = listArchivedFindings('inspect-run-1', engine);
    assert.equal(findings[0].question, 'q1');
    assert.equal(findings[0].sourceCount, 1);
  });

  it('throws when run is missing', () => {
    const engine = seedEngine();
    assert.throws(
      () => showArchivedRun('missing', engine),
      /Archived research run not found/,
    );
  });
});
