import fs from 'node:fs';
import path from 'node:path';
import { renderPage } from './markdown.mjs';
import { wikilinkPath } from './obsidian.mjs';

export const VAULT_DIRS = [
  'Sources',
  'Topics',
  'Claims',
  'Questions',
  'Lint',
  'Templates',
];

export function resolveVaultDir(vaultDir) {
  return path.resolve(vaultDir);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeVaultFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function listMarkdownPages(vaultDir) {
  const root = resolveVaultDir(vaultDir);
  const pages = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        pages.push({
          absolutePath: full,
          relativePath: path.relative(root, full).replace(/\\/g, '/'),
        });
      }
    }
  }

  walk(root);
  return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function readPage(vaultDir, relativePath) {
  const full = path.join(resolveVaultDir(vaultDir), relativePath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

const TEMPLATES = {
  'Templates/Topic.md': `---
type: topic
title: Topic Title
aliases: []
tags:
  - topic
sources: []
---

# Topic Title

## Summary

## Related Sources

`,
  'Templates/Source.md': `---
type: source
title: Source Title
tags:
  - source
---

# Source Title

## Evidence

`,
  'Templates/Claim.md': `---
type: claim
topic: Topic Title
tags:
  - claim
---

# Claims

`,
};

export function initWiki({ vaultDir, initObsidianConfig = false } = {}) {
  const root = resolveVaultDir(vaultDir);
  ensureDir(root);

  for (const dir of VAULT_DIRS) {
    ensureDir(path.join(root, dir));
  }

  for (const [rel, content] of Object.entries(TEMPLATES)) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) {
      writeVaultFile(target, content);
    }
  }

  const homePath = path.join(root, 'Home.md');
  if (!fs.existsSync(homePath)) {
    writeVaultFile(homePath, renderPage({
      frontmatter: { type: 'home', title: 'Home' },
      body: `# Home\n\nWelcome to your LLM Wiki vault.\n\n- ${wikilinkPath('Map of Content', 'Map of Content')}\n`,
    }));
  }

  const mocPath = path.join(root, 'Map of Content.md');
  if (!fs.existsSync(mocPath)) {
    writeVaultFile(mocPath, renderPage({
      frontmatter: { type: 'moc', title: 'Map of Content' },
      body: '# Map of Content\n\n## Topics\n\n## Sources\n\n## Claims\n\n',
    }));
  }

  if (initObsidianConfig) {
    const obsidianDir = path.join(root, '.obsidian');
    ensureDir(obsidianDir);
    const appJson = path.join(obsidianDir, 'app.json');
    if (!fs.existsSync(appJson)) {
      fs.writeFileSync(appJson, JSON.stringify({
        legacyEditor: false,
        showLineNumber: true,
        useMarkdownLinks: false,
      }, null, 2), 'utf8');
    }
  }

  return { vaultDir: root };
}
