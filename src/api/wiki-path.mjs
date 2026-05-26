import fs from 'node:fs';
import path from 'node:path';
import { extractWikilinks, listMarkdownPages, readPage, resolveVaultDir } from 'js-wiki-engine';

export function resolveVaultRelativePath(vaultDir, requestedPath) {
  const root = resolveVaultDir(vaultDir);
  const rel = String(requestedPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

  if (!rel || rel.includes('..')) {
    throw new Error('Invalid page path');
  }

  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid page path');
  }
  if (!full.endsWith('.md')) {
    throw new Error('Not a markdown page');
  }
  if (!fs.existsSync(full)) {
    return null;
  }

  return path.relative(root, full).replace(/\\/g, '/');
}

export function resolveWikilinkAbsolutePath(vaultDir, fromRelativePath, target) {
  const root = resolveVaultDir(vaultDir);
  const fromDir = path.dirname(path.join(root, fromRelativePath));
  const normalizedTarget = String(target || '').trim().replace(/\\/g, '/');
  const candidates = [
    path.join(fromDir, `${normalizedTarget}.md`),
    path.join(root, `${normalizedTarget}.md`),
    path.join(root, `${normalizedTarget.replace(/\//g, path.sep)}.md`),
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function resolveWikilinkRelativePath(vaultDir, fromRelativePath, target) {
  const absolute = resolveWikilinkAbsolutePath(vaultDir, fromRelativePath, target);
  if (!absolute) return null;
  const root = resolveVaultDir(vaultDir);
  return path.relative(root, absolute).replace(/\\/g, '/');
}

export function parsePageFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter = {};
  let currentListKey = null;
  for (const line of match[1].split('\n')) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentListKey) {
      frontmatter[currentListKey] = frontmatter[currentListKey] || [];
      frontmatter[currentListKey].push(listItem[1].replace(/^["']|["']$/g, '').trim());
      continue;
    }
    const scalar = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;
    currentListKey = scalar[2].trim() === '' ? scalar[1] : null;
    if (currentListKey) {
      frontmatter[currentListKey] = [];
      continue;
    }
    currentListKey = null;
    frontmatter[scalar[1]] = scalar[2].replace(/^["']|["']$/g, '').trim();
  }

  const body = content.slice(match[0].length).replace(/^\s+/, '');
  return { frontmatter, body };
}

export function pageTitleFromPath(relativePath, frontmatter = {}) {
  if (frontmatter.title) return frontmatter.title;
  const base = path.basename(relativePath, '.md');
  return base.replace(/^Source \d{3} - /, '').trim() || base;
}

export function listVaultPagesGrouped(vaultDir) {
  const pages = listMarkdownPages(vaultDir)
    .filter((page) => !page.relativePath.startsWith('Templates/'))
    .map((page) => {
      const content = readPage(vaultDir, page.relativePath) ?? '';
      const { frontmatter } = parsePageFrontmatter(content);
      const segment = page.relativePath.includes('/')
        ? page.relativePath.split('/')[0]
        : '(root)';
      return {
        relativePath: page.relativePath,
        segment,
        title: pageTitleFromPath(page.relativePath, frontmatter),
        type: frontmatter.type || null,
      };
    });

  const groups = {};
  for (const page of pages) {
    groups[page.segment] = groups[page.segment] || [];
    groups[page.segment].push(page);
  }

  const order = ['(root)', 'Topics', 'Sources', 'Claims', 'Questions', 'Lint'];
  const sortedGroups = Object.keys(groups).sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return { pages, groups, sortedGroups };
}

export function readVaultPage(vaultDir, requestedPath) {
  let relativePath = null;
  try {
    relativePath = resolveVaultRelativePath(vaultDir, requestedPath);
  } catch {
    relativePath = null;
  }

  if (!relativePath) {
    const target = String(requestedPath || '').replace(/\.md$/i, '').trim();
    relativePath = resolveWikilinkRelativePath(vaultDir, 'Home.md', target);
  }

  if (!relativePath) {
    return null;
  }

  const raw = readPage(vaultDir, relativePath);
  if (!raw) return null;

  const { frontmatter, body } = parsePageFrontmatter(raw);
  const wikilinks = extractWikilinks(body);
  const links = wikilinks.map((link) => {
    const resolved = resolveWikilinkRelativePath(vaultDir, relativePath, link.target);
    return {
      target: link.target,
      alias: link.alias,
      relativePath: resolved,
      exists: Boolean(resolved),
    };
  });

  return {
    relativePath,
    title: pageTitleFromPath(relativePath, frontmatter),
    type: frontmatter.type || null,
    frontmatter,
    markdown: body,
    links,
  };
}
