import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileWiki, lintWiki, loadSourcesFromIntelStore } from 'js-wiki-engine';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';

describe('wiki compile (host)', () => {
  const tempDirs = [];

  afterEach(() => {
    resetIntelStoreEngine();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compiles vault from intel store artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-wiki-host-'));
    tempDirs.push(root);

    const engine = createIntelStoreEngine({ baseDir: path.join(root, 'intel') });
    const researchId = 'wiki-host-run';

    archiveResearchResult({
      researchId,
      query: 'llm wiki',
      strategy: 'source-based',
      result: {
        report: '# Report\n\n## Summary\n\n- Karpathy LLM Wiki uses ingest/query/lint pipelines for knowledge [1.1]\n',
        findings: [{ question: 'What is LLM Wiki?', iteration: 1, sources: [] }],
        sources: [
          { title: 'LLM Wiki Post', url: 'https://example.com/llm-wiki', snippet: 'Karpathy wiki', engine: 'test' },
        ],
      },
      artifacts: { sessionDir: path.join(root, 'session') },
      engine,
    });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    const vaultDir = path.join(root, 'wiki');
    const summary = compileWiki({
      vaultDir,
      sources: loaded.sources,
      report: loaded.report,
      meta: loaded.meta,
    });

    assert.ok(summary.compiled >= 1);
    assert.ok(fs.existsSync(path.join(vaultDir, 'manifest.json')));

    const lint = lintWiki({ vaultDir });
    assert.equal(lint.errorCount, 0);
  });

  it('compiles vault from intel store after work_dir session is removed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-wiki-portable-'));
    tempDirs.push(root);

    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    const engine = createIntelStoreEngine({ baseDir: path.join(root, 'intel') });
    const researchId = 'portable-wiki-run';

    archiveResearchResult({
      researchId,
      query: 'portable compile',
      strategy: 'source-based',
      result: {
        report: '# Report\n\n## Summary\n\n- Portable intel compile works without work_dir [1.1]\n',
        findings: [{ question: 'Can intel compile alone?', iteration: 1, sources: [] }],
        sources: [
          {
            title: 'Portable Source',
            url: 'https://example.com/portable',
            snippet: 'portable snippet',
            content: 'Portable source body content.',
            engine: 'test',
            fetchStatus: 'ok',
          },
        ],
      },
      artifacts: {
        sessionDir,
        reportPath: path.join(sessionDir, 'report.md'),
      },
      engine,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    assert.match(loaded.report, /Portable intel compile/);
    assert.equal(loaded.sources.length, 1);
    assert.equal(loaded.sources[0].content, 'Portable source body content.');

    const vaultDir = path.join(root, 'wiki');
    const summary = compileWiki({
      vaultDir,
      sources: loaded.sources,
      report: loaded.report,
      meta: loaded.meta,
    });

    assert.ok(summary.compiled >= 1);
    assert.ok(fs.existsSync(path.join(vaultDir, 'Topics')));
    assert.equal(lintWiki({ vaultDir }).errorCount, 0);
  });
});
