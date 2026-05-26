import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileWiki } from '../src/ingest.mjs';
import { loadManifest } from '../src/manifest.mjs';
import { hashSource } from '../src/schema.mjs';
import { listMarkdownPages } from '../src/vault.mjs';

describe('compileWiki', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const sampleSources = [
    {
      id: 'run-1/source-001',
      researchId: 'run-1',
      query: 'llm wiki',
      title: 'Karpathy LLM Wiki',
      url: 'https://example.com/wiki',
      snippet: 'LLM wiki concept',
      sourceIndex: 1,
    },
    {
      id: 'run-1/source-002',
      researchId: 'run-1',
      query: 'llm wiki',
      title: 'Second Source',
      url: 'https://example.com/second',
      snippet: 'More context',
      sourceIndex: 2,
    },
  ];

  const report = `## Findings\n\n- Karpathy proposes raw/wiki/schema layers for LLM knowledge [1.1]\n- Manifest enables incremental compile [1.2]\n`;

  it('compiles source, topic, claim pages and manifest', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-compile-'));
    tempDirs.push(vaultDir);

    const summary = compileWiki({
      vaultDir,
      sources: sampleSources,
      report,
      meta: { query: 'llm wiki' },
    });

    assert.equal(summary.compiled, 2);
    assert.ok(summary.topics.includes('Llm Wiki'));

    const pages = listMarkdownPages(vaultDir);
    const rels = pages.map((p) => p.relativePath);
    assert.ok(rels.some((r) => r.startsWith('Sources/run-1/')));
    assert.ok(rels.includes('Topics/Llm Wiki.md'));
    assert.ok(rels.includes('Claims/Llm Wiki Claims.md'));

    const manifest = loadManifest(vaultDir);
    assert.equal(Object.keys(manifest.sources).length, 2);
    assert.ok(fs.existsSync(path.join(vaultDir, 'manifest.json')));
  });

  it('skips unchanged sources on second compile', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-incr-'));
    tempDirs.push(vaultDir);

    compileWiki({ vaultDir, sources: sampleSources, report, meta: { query: 'llm wiki' } });
    const second = compileWiki({ vaultDir, sources: sampleSources, report, meta: { query: 'llm wiki' } });

    assert.equal(second.skipped, 2);
    assert.equal(second.compiled, 0);
  });

  it('recompiles when source hash changes', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-hash-'));
    tempDirs.push(vaultDir);

    compileWiki({ vaultDir, sources: sampleSources, report });
    const changed = sampleSources.map((s) => ({ ...s, snippet: 'updated snippet' }));
    const third = compileWiki({ vaultDir, sources: changed, report });

    assert.equal(third.compiled, 2);
    assert.notEqual(hashSource(sampleSources[0]), hashSource(changed[0]));
  });
});
