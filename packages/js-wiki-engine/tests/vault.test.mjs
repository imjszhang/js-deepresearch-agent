import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { initWiki, listMarkdownPages } from '../src/vault.mjs';

describe('initWiki', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates vault dirs, templates, home and moc', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vault-'));
    tempDirs.push(vaultDir);

    const result = initWiki({ vaultDir });
    assert.equal(result.vaultDir, path.resolve(vaultDir));

    for (const dir of ['Sources', 'Topics', 'Claims', 'Questions', 'Lint', 'Templates']) {
      assert.ok(fs.existsSync(path.join(vaultDir, dir)));
    }

    assert.ok(fs.existsSync(path.join(vaultDir, 'Home.md')));
    assert.ok(fs.existsSync(path.join(vaultDir, 'Map of Content.md')));
    assert.ok(fs.existsSync(path.join(vaultDir, 'Templates', 'Topic.md')));

    const pages = listMarkdownPages(vaultDir);
    assert.ok(pages.some((p) => p.relativePath === 'Home.md'));
  });

  it('writes minimal obsidian config when requested', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vault-obs-'));
    tempDirs.push(vaultDir);

    initWiki({ vaultDir, initObsidianConfig: true });
    const appJson = path.join(vaultDir, '.obsidian', 'app.json');
    assert.ok(fs.existsSync(appJson));
    const parsed = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    assert.equal(parsed.useMarkdownLinks, false);
  });
});
