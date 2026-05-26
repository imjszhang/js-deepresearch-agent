import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  listVaultPagesGrouped,
  readVaultPage,
  resolveVaultRelativePath,
} from '../src/api/wiki-path.mjs';
import { initWiki } from 'js-wiki-engine';

function writePage(vaultDir, relativePath, content) {
  const full = path.join(vaultDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('wiki path helpers', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedVault() {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-path-'));
    tempDirs.push(vaultDir);
    initWiki({ vaultDir });
    writePage(vaultDir, 'Topics/Alpha.md', `---
type: topic
title: Alpha Topic
---

# Alpha

See [[Home]] and [[Claims/Beta Claims|Beta]].
`);
    writePage(vaultDir, 'Claims/Beta Claims.md', `---
type: claim
title: Beta Claims
---

# Beta Claims
`);
    return vaultDir;
  }

  it('rejects path traversal', () => {
    const vaultDir = seedVault();
    assert.throws(
      () => resolveVaultRelativePath(vaultDir, '../outside.md'),
      /Invalid page path/,
    );
  });

  it('lists grouped pages excluding templates', () => {
    const vaultDir = seedVault();
    const listing = listVaultPagesGrouped(vaultDir);
    assert.ok(listing.pages.some((p) => p.relativePath === 'Topics/Alpha.md'));
    assert.ok(listing.sortedGroups.includes('Topics'));
  });

  it('reads page body and resolves wikilinks', () => {
    const vaultDir = seedVault();
    const page = readVaultPage(vaultDir, 'Topics/Alpha.md');
    assert.equal(page.title, 'Alpha Topic');
    assert.match(page.markdown, /# Alpha/);
    assert.equal(page.links.length, 2);
    const home = page.links.find((l) => l.target === 'Home');
    assert.equal(home.exists, true);
    assert.equal(home.relativePath, 'Home.md');
  });

  it('opens page by wikilink target without md extension', () => {
    const vaultDir = seedVault();
    const page = readVaultPage(vaultDir, 'Topics/Alpha');
    assert.equal(page.relativePath, 'Topics/Alpha.md');
  });
});
