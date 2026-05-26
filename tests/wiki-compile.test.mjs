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
});
