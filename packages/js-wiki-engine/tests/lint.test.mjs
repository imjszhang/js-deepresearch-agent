import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileWiki } from '../src/ingest.mjs';
import { lintWiki } from '../src/lint.mjs';
import { saveManifest, createEmptyManifest } from '../src/manifest.mjs';

describe('lintWiki', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes on a freshly compiled vault', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-lint-'));
    tempDirs.push(vaultDir);

    compileWiki({
      vaultDir,
      sources: [{
        researchId: 'lint-run',
        query: 'test topic',
        title: 'Source A',
        url: 'https://a.test',
        snippet: 'alpha',
        sourceIndex: 1,
      }],
      report: '## Notes\n\n- A stable claim with enough characters to pass extraction.\n',
    });

    const result = lintWiki({ vaultDir });
    assert.equal(result.errorCount, 0);
    assert.ok(result.ok);
    assert.ok(fs.existsSync(result.reportPath));
  });

  it('detects broken wikilinks and manifest missing pages', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-lint-bad-'));
    tempDirs.push(vaultDir);

    fs.mkdirSync(path.join(vaultDir, 'Topics'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'Topics', 'Broken.md'),
      '---\ntype: topic\ntitle: Broken\nsources:\n  - x\n---\n\n[[Does/Not/Exist]]\n',
      'utf8',
    );

    const manifest = createEmptyManifest();
    manifest.sources['fake/source'] = {
      hash: 'abc',
      pages: ['Sources/missing.md'],
      researchId: 'fake',
    };
    saveManifest(vaultDir, manifest);

    const result = lintWiki({ vaultDir });
    assert.ok(result.errorCount >= 2);
    assert.ok(result.issues.some((i) => i.code === 'broken_wikilink'));
    assert.ok(result.issues.some((i) => i.code === 'manifest_missing_page'));
  });
});
