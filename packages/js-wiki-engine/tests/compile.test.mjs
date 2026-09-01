import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileWiki } from '../src/ingest.mjs';
import { loadManifest } from '../src/manifest.mjs';
import { hashSource } from '../src/schema.mjs';
import { listMarkdownPages } from '../src/vault.mjs';
import { lintWiki } from '../src/lint.mjs';

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

  it('compiles Schema v3 evidence and open-question pages incrementally', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-v3-'));
    tempDirs.push(vaultDir);
    const claims = [
      { id: 'claim-1', text: 'LLM Wiki uses incremental manifests.', kind: 'key_claim', section: 'Findings', evaluation: { verdict: 'supported', origin: 'stored_rule' }, evidence: [{ sourceId: 'run-1/source-001', passageId: 'passage-1', verdict: 'supported', score: 0.9 }] },
      { id: 'claim-source', text: 'https://example.com/wiki', kind: 'source_entry', section: 'Sources', evidence: [] },
      { id: 'claim-caveat', text: 'The available evidence is limited.', kind: 'caveat', section: 'Limitations', evaluation: { verdict: 'unverifiable', origin: 'stored_rule' }, evidence: [] },
    ];
    const passages = [{ id: 'passage-1', sourceId: 'run-1/source-001', text: 'Manifest enables incremental compile.', contentHash: 'abc' }];
    const gaps = [
      { id: 'gap-1', question: 'How does it evolve?', status: 'deferred', priority: 'normal', reason: 'Needs future evidence.' },
      { id: 'gap-root', question: 'llm wiki', status: 'verified', rollup: true, priority: 'critical' },
      {
        id: 'gap-2',
        question: 'What is supported?',
        status: 'verified',
        requiredSlot: true,
        slotSupport: { verdict: 'supported', quote: 'Manifest enables incremental compile.', quoteAnchored: true },
      },
    ];
    const summary = compileWiki({ vaultDir, sources: sampleSources, report, meta: { query: 'llm wiki' }, claims, passages, gaps });
    assert.ok(summary.pages.includes('Evidence/run-1/claim-1.md'));
    assert.ok(summary.pages.includes('Open Questions/Llm Wiki.md'));
    const manifest = loadManifest(vaultDir);
    assert.ok(manifest.claims['claim-1']);
    assert.ok(manifest.passages['passage-1']);
    assert.ok(manifest.gaps['gap-1']);
    assert.equal(lintWiki({ vaultDir }).errorCount, 0);
    const claimsPage = fs.readFileSync(path.join(vaultDir, 'Claims', 'Llm Wiki Claims.md'), 'utf8');
    assert.match(claimsPage, /claimCount: 1/);
    assert.match(claimsPage, /## Caveats/);
    assert.doesNotMatch(claimsPage, /claim-source/);
    const questionsPage = fs.readFileSync(path.join(vaultDir, 'Open Questions', 'Llm Wiki.md'), 'utf8');
    assert.match(questionsPage, /How does it evolve/);
    assert.doesNotMatch(questionsPage, /What is supported/);
    assert.doesNotMatch(questionsPage, /gap-root/);
  });
});
