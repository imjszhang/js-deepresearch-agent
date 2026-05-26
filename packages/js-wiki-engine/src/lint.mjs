import fs from 'node:fs';
import path from 'node:path';
import { extractWikilinks } from './markdown.mjs';
import { loadManifest, manifestPath } from './manifest.mjs';
import { listMarkdownPages, readPage, resolveVaultDir } from './vault.mjs';

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const result = {};
  let currentListKey = null;

  for (const line of block.split('\n')) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentListKey) {
      result[currentListKey] = result[currentListKey] || [];
      result[currentListKey].push(listItem[1].replace(/^["']|["']$/g, '').trim());
      continue;
    }

    const scalar = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;

    currentListKey = scalar[2].trim() === '' ? scalar[1] : null;
    if (currentListKey) {
      result[currentListKey] = [];
      continue;
    }

    currentListKey = null;
    result[scalar[1]] = scalar[2].replace(/^["']|["']$/g, '').trim();
  }
  return result;
}

function resolveWikilinkTarget(vaultDir, fromRelativePath, target) {
  const root = resolveVaultDir(vaultDir);
  const fromDir = path.dirname(path.join(root, fromRelativePath));
  const candidates = [
    path.join(fromDir, `${target}.md`),
    path.join(root, `${target}.md`),
    path.join(root, `${target.replace(/\//g, path.sep)}.md`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function lintWiki({ vaultDir } = {}) {
  const root = resolveVaultDir(vaultDir);
  const issues = [];
  const pages = listMarkdownPages(root);

  for (const page of pages) {
    const content = readPage(root, page.relativePath);
    if (!content) continue;

    const fm = parseFrontmatter(content);
    if (page.relativePath.startsWith('Sources/') && fm.type === 'source') {
      if (!fm.url || fm.url === 'null') {
        issues.push({
          severity: 'warn',
          code: 'missing_url',
          page: page.relativePath,
          message: 'Source page has no URL in frontmatter',
        });
      }
    }

    if (page.relativePath.startsWith('Topics/') && fm.type === 'topic') {
      const sources = fm.sources;
      const hasSources = Array.isArray(sources)
        ? sources.length > 0
        : Boolean(sources && sources !== '[]');
      if (!hasSources) {
        issues.push({
          severity: 'warn',
          code: 'topic_no_sources',
          page: page.relativePath,
          message: 'Topic page lists no sources in frontmatter',
        });
      }
    }

    const skipWikilinkLint = page.relativePath.startsWith('Lint/')
      || page.relativePath.startsWith('Templates/');
    if (!skipWikilinkLint) {
      for (const link of extractWikilinks(content)) {
        const resolved = resolveWikilinkTarget(root, page.relativePath, link.target);
        if (!resolved) {
          issues.push({
            severity: 'error',
            code: 'broken_wikilink',
            page: page.relativePath,
            message: `Broken wikilink target: ${link.target}`,
          });
        }
      }
    }
  }

  const manifestFile = manifestPath(root);
  if (fs.existsSync(manifestFile)) {
    const manifest = loadManifest(root);
    for (const [sourceId, entry] of Object.entries(manifest.sources || {})) {
      for (const rel of entry.pages || []) {
        const full = path.join(root, rel);
        if (!fs.existsSync(full)) {
          issues.push({
            severity: 'error',
            code: 'manifest_missing_page',
            page: rel,
            message: `Manifest references missing page for source ${sourceId}`,
          });
        }
      }
    }
  } else {
    issues.push({
      severity: 'warn',
      code: 'missing_manifest',
      page: 'manifest.json',
      message: 'manifest.json not found',
    });
  }

  const lintReport = renderLintReport(issues);
  const lintPath = path.join(root, 'Lint', 'latest.md');
  fs.mkdirSync(path.dirname(lintPath), { recursive: true });
  fs.writeFileSync(lintPath, lintReport, 'utf8');

  return {
    ok: issues.filter((i) => i.severity === 'error').length === 0,
    issueCount: issues.length,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warnCount: issues.filter((i) => i.severity === 'warn').length,
    issues,
    reportPath: lintPath,
  };
}

function renderLintReport(issues) {
  const lines = [
    '---',
    'type: lint',
    'title: Latest Lint Report',
    '---',
    '',
    '# Latest Lint Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Issues: ${issues.length}`,
    '',
  ];

  if (!issues.length) {
    lines.push('_No issues found._');
    return lines.join('\n');
  }

  for (const issue of issues) {
    const safeMessage = String(issue.message).replace(/\[\[/g, '`[[').replace(/\]\]/g, ']]`');
    lines.push(`- **${issue.severity}** \`${issue.code}\` @ ${issue.page}: ${safeMessage}`);
  }
  return lines.join('\n');
}
