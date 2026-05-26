import path from 'node:path';
import { escapeLiteralWikilinks, extractClaimLines, renderPage } from './markdown.mjs';
import {
  loadManifest,
  saveManifest,
  shouldRecompileSource,
  recordSourceCompile,
  recordTopicCompile,
} from './manifest.mjs';
import {
  safeObsidianFilename,
  titleCaseQuery,
  wikilinkPath,
} from './obsidian.mjs';
import { hashSource, groupSourcesByResearch, normalizeWikiSource } from './schema.mjs';
import { initWiki, resolveVaultDir, writeVaultFile } from './vault.mjs';

function researchFolderName(researchId) {
  return safeObsidianFilename(researchId, { maxLength: 80 });
}

function sourcePageRelativePath(source) {
  const folder = researchFolderName(source.researchId);
  const title = safeObsidianFilename(
    `Source ${String(source.sourceIndex).padStart(3, '0')} - ${source.title || 'Untitled'}`,
    { maxLength: 100 },
  );
  return `Sources/${folder}/${title}.md`;
}

function topicPageRelativePath(topicTitle) {
  return `Topics/${safeObsidianFilename(topicTitle)}.md`;
}

function claimsPageRelativePath(topicTitle) {
  return `Claims/${safeObsidianFilename(`${topicTitle} Claims`)}.md`;
}

function buildSourcePage(source, topicTitle) {
  const rel = sourcePageRelativePath(source);
  const body = [
    `# ${source.title || 'Untitled Source'}`,
    '',
    '## Metadata',
    '',
    `- URL: ${source.url || '(none)'}`,
    `- Research: ${source.researchId}`,
    `- Query: ${source.query || '(none)'}`,
    source.engine ? `- Engine: ${source.engine}` : null,
    '',
    '## Evidence',
    '',
    source.snippet ? `> ${escapeLiteralWikilinks(source.snippet)}` : '_No snippet._',
    '',
    source.content && source.content !== source.snippet
      ? `### Content\n\n${escapeLiteralWikilinks(source.content.slice(0, 4000))}`
      : null,
    '',
    '## Artifact Paths',
    '',
    ...Object.entries(source.artifactPaths || {}).map(
      ([key, value]) => (value ? `- ${key}: \`${value}\`` : null),
    ).filter(Boolean),
    '',
    '## Related',
    '',
    `- Topic: ${wikilinkPath(topicPageRelativePath(topicTitle))}`,
  ].filter((line) => line !== null).join('\n');

  return {
    relativePath: rel,
    content: renderPage({
      frontmatter: {
        type: 'source',
        title: source.title || `Source ${source.sourceIndex}`,
        researchId: source.researchId,
        sourceId: source.id,
        url: source.url || null,
        tags: [...new Set(['source', ...(source.tags || [])])],
        topic: topicTitle,
        updated: new Date().toISOString().slice(0, 10),
      },
      body,
    }),
  };
}

function buildTopicPage(topicTitle, sources, report = '') {
  const sourceLinks = sources.map((source) => {
    const rel = sourcePageRelativePath(source);
    return `- ${wikilinkPath(rel, source.title || `Source ${source.sourceIndex}`)}`;
  });

  const summary = report
    ? report.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
    : '';

  const body = [
    `# ${topicTitle}`,
    '',
    '## Summary',
    '',
    summary ? summary.slice(0, 800) : '_Compiled from research sources. Expand via LLM ingest later._',
    '',
    '## Related Sources',
    '',
    ...sourceLinks,
    '',
    '## Claims',
    '',
    `- ${wikilinkPath(claimsPageRelativePath(topicTitle), `${topicTitle} Claims`)}`,
  ].join('\n');

  return {
    relativePath: topicPageRelativePath(topicTitle),
    content: renderPage({
      frontmatter: {
        type: 'topic',
        title: topicTitle,
        aliases: [topicTitle],
        tags: ['topic', ...topicTitle.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3)],
        sources: sources.map((s) => s.id),
        updated: new Date().toISOString().slice(0, 10),
      },
      body,
    }),
  };
}

function buildClaimsPage(topicTitle, report, sources) {
  const claims = extractClaimLines(report);
  const lines = claims.length
    ? claims.map((claim, index) => {
        const cite = claim.hasCitation ? ' _(has citation)_' : ' _(no citation)_';
        return `${index + 1}. **${claim.section || 'General'}**: ${claim.text}${cite}`;
      })
    : ['_No extractable claims from report._'];

  const body = [
    `# ${topicTitle} Claims`,
    '',
    `Topic: ${wikilinkPath(topicPageRelativePath(topicTitle))}`,
    '',
    '## Extracted Claims',
    '',
    ...lines,
    '',
    '## Source Index',
    '',
    ...sources.map((s) => `- ${wikilinkPath(sourcePageRelativePath(s), s.title || s.id)}`),
  ].join('\n');

  return {
    relativePath: claimsPageRelativePath(topicTitle),
    content: renderPage({
      frontmatter: {
        type: 'claim',
        topic: topicTitle,
        tags: ['claim'],
        claimCount: claims.length,
        updated: new Date().toISOString().slice(0, 10),
      },
      body,
    }),
  };
}

function buildHomeAndMoc(topicEntries) {
  const topicLinks = topicEntries.map(({ title, topicRel, claimsRel, sourceCount }) => [
    `### ${wikilinkPath(topicRel, title)}`,
    '',
    `- Sources: ${sourceCount}`,
    `- Claims: ${wikilinkPath(claimsRel, 'Claims')}`,
    '',
  ].join('\n'));

  const home = renderPage({
    frontmatter: { type: 'home', title: 'Home', updated: new Date().toISOString().slice(0, 10) },
    body: [
      '# Home',
      '',
      'LLM Wiki vault compiled by js-wiki-engine.',
      '',
      `- ${wikilinkPath('Map of Content', 'Map of Content')}`,
      '',
      '## Topics',
      '',
      ...topicEntries.map(({ topicRel, title }) => `- ${wikilinkPath(topicRel, title)}`),
    ].join('\n'),
  });

  const moc = renderPage({
    frontmatter: { type: 'moc', title: 'Map of Content', updated: new Date().toISOString().slice(0, 10) },
    body: ['# Map of Content', '', '## Topics', '', topicLinks].join('\n'),
  });

  return { home, moc };
}

export function compileWiki({
  vaultDir,
  sources = [],
  report = '',
  meta = {},
  llm = null,
  mode = 'deterministic',
  force = false,
} = {}) {
  if (llm && mode !== 'deterministic') {
    throw new Error('LLM compile mode is not implemented in MVP');
  }

  initWiki({ vaultDir });
  const root = resolveVaultDir(vaultDir);
  const manifest = loadManifest(root);
  const normalized = sources.map((s, i) => normalizeWikiSource({ ...s, query: s.query || meta.query }, i));
  const groups = groupSourcesByResearch(normalized);

  const summary = {
    vaultDir: root,
    compiled: 0,
    skipped: 0,
    topics: [],
    pages: [],
  };

  const topicEntries = [];

  for (const [researchId, researchSources] of groups) {
    const query = researchSources[0]?.query || meta.query || researchId;
    const topicTitle = titleCaseQuery(query);
    const topicPages = [];

    for (const source of researchSources) {
      const hash = hashSource(source);
      if (!force && !shouldRecompileSource(manifest, source.id, hash)) {
        summary.skipped += 1;
        continue;
      }

      const page = buildSourcePage(source, topicTitle);
      writeVaultFile(path.join(root, page.relativePath), page.content);
      recordSourceCompile(manifest, source, hash, [page.relativePath]);
      summary.compiled += 1;
      summary.pages.push(page.relativePath);
      topicPages.push(page.relativePath);
    }

    const topicPage = buildTopicPage(topicTitle, researchSources, report);
    writeVaultFile(path.join(root, topicPage.relativePath), topicPage.content);
    topicPages.push(topicPage.relativePath);

    const claimsPage = buildClaimsPage(topicTitle, report, researchSources);
    writeVaultFile(path.join(root, claimsPage.relativePath), claimsPage.content);
    topicPages.push(claimsPage.relativePath);

    recordTopicCompile(manifest, topicTitle, topicPages);
    topicEntries.push({
      title: topicTitle,
      topicRel: topicPage.relativePath,
      claimsRel: claimsPage.relativePath,
      sourceCount: researchSources.length,
      researchId,
    });
    summary.topics.push(topicTitle);
  }

  const { home, moc } = buildHomeAndMoc(topicEntries);
  writeVaultFile(path.join(root, 'Home.md'), home);
  writeVaultFile(path.join(root, 'Map of Content.md'), moc);
  summary.pages.push('Home.md', 'Map of Content.md');

  manifest.compiledAt = new Date().toISOString();
  saveManifest(root, manifest);

  return summary;
}
