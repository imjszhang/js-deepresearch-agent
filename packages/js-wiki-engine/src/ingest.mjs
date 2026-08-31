import path from 'node:path';
import crypto from 'node:crypto';
import { escapeLiteralWikilinks, extractClaimLines, renderPage } from './markdown.mjs';
import {
  loadManifest,
  saveManifest,
  shouldRecompileSource,
  recordSourceCompile,
  recordTopicCompile,
  shouldRecompileEntity,
  recordEntityCompile,
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

function evidencePageRelativePath(researchId, claimId) {
  return `Evidence/${researchFolderName(researchId)}/${safeObsidianFilename(claimId)}.md`;
}

function openQuestionsRelativePath(topicTitle) {
  return `Open Questions/${safeObsidianFilename(topicTitle)}.md`;
}

function entityHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
    source.publisher ? `- Publisher: ${source.publisher}` : null,
    source.author ? `- Author: ${source.author}` : null,
    source.publishedAt ? `- Published: ${source.publishedAt}` : null,
    source.updatedAt ? `- Source updated: ${source.updatedAt}` : null,
    source.accessedAt ? `- Accessed: ${source.accessedAt}` : null,
    source.sourceType ? `- Source type: ${source.sourceType}` : null,
    source.jurisdiction ? `- Jurisdiction: ${source.jurisdiction}` : null,
    source.productVersion ? `- Product version: ${source.productVersion}` : null,
    source.accessStatus ? `- Access status: ${source.accessStatus}` : null,
    source.accessNotes ? `- Access notes: ${source.accessNotes}` : null,
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

function buildClaimsPage(topicTitle, report, sources, claimArtifacts = [], researchId = '') {
  const claims = claimArtifacts.length
    ? claimArtifacts.map(normalizeWikiClaim).filter((claim) => !['source_entry', 'metadata'].includes(claim.kind))
    : extractClaimLines(report).map((claim) => ({ ...claim, kind: 'supporting_claim' }));
  const facts = claims.filter((claim) => ['key_claim', 'supporting_claim'].includes(claim.kind));
  const caveats = claims.filter((claim) => claim.kind === 'caveat');
  const recommendations = claims.filter((claim) => claim.kind === 'recommendation');

  function renderClaim(claim, index) {
    const cite = claimArtifacts.length
      ? ` _(${claim.effectiveVerdict}; ${claim.evidence?.length || 0} evidence; ${claim.evaluationOrigin})_`
      : (claim.hasCitation ? ' _(has citation)_' : ' _(no citation)_');
    const evidenceLink = claim.id && researchId ? ` — ${wikilinkPath(evidencePageRelativePath(researchId, claim.id), 'Evidence')}` : '';
    return `${index + 1}. **${claim.section || 'General'}**: ${claim.text}${cite}${evidenceLink}`;
  }

  const body = [
    `# ${topicTitle} Claims`,
    '',
    `Topic: ${wikilinkPath(topicPageRelativePath(topicTitle))}`,
    '',
    '## Fact Claims',
    '',
    ...(facts.length ? facts.map(renderClaim) : ['_No extractable fact claims._']),
    '',
    '## Caveats',
    '',
    ...(caveats.length ? caveats.map(renderClaim) : ['_No caveats._']),
    '',
    '## Recommendations',
    '',
    ...(recommendations.length ? recommendations.map(renderClaim) : ['_No recommendations._']),
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
        claimCount: facts.length,
        caveatCount: caveats.length,
        recommendationCount: recommendations.length,
        updated: new Date().toISOString().slice(0, 10),
      },
      body,
    }),
  };
}

function normalizeWikiClaim(claim = {}) {
  const section = String(claim.section || '').toLowerCase();
  const inferredKind = /sources|references|参考文献|主要来源|引用来源/.test(section)
    ? 'source_entry'
    : (/caveats|limitations|局限|限制/.test(section) ? 'caveat'
      : (/recommend|建议/.test(section) ? 'recommendation'
        : (/summary|key findings|摘要|主要发现|核心/.test(section) ? 'key_claim' : 'supporting_claim')));
  const evidenceVerdicts = (claim.evidence || []).map((item) => item.verdict);
  const legacyVerdict = evidenceVerdicts.includes('unsupported') && (evidenceVerdicts.includes('supported') || evidenceVerdicts.includes('partially_supported'))
    ? 'conflicting'
    : (evidenceVerdicts.includes('unsupported') ? 'unsupported'
      : (evidenceVerdicts.includes('supported') ? 'supported'
        : (evidenceVerdicts.includes('partially_supported') ? 'partially_supported' : 'unverifiable')));
  return {
    ...claim,
    kind: claim.kind || inferredKind,
    effectiveVerdict: claim.evaluation?.verdict || legacyVerdict,
    evaluationOrigin: claim.evaluation?.origin || 'stored_rule',
  };
}

function buildEvidencePage({ researchId, claim, passages, sources }) {
  const passageMap = new Map(passages.map((passage) => [passage.id, passage]));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const missingPassages = (claim.evidence || []).filter((entry) => !passageMap.has(entry.passageId)).length;
  const missingSources = (claim.evidence || []).filter((entry) => !sourceMap.has(entry.sourceId)).length;
  const blocks = (claim.evidence || []).map((entry, index) => {
    const passage = passageMap.get(entry.passageId);
    const source = sourceMap.get(entry.sourceId);
    return [
      `## Evidence ${index + 1}: ${entry.verdict}`,
      '',
      source ? `Source: ${wikilinkPath(sourcePageRelativePath(source), source.title || source.id)}` : `Source ID: ${entry.sourceId}`,
      passage?.section ? `Section: ${passage.section}` : null,
      '',
      passage?.text ? `> ${escapeLiteralWikilinks(passage.text.slice(0, 1600))}` : '_Passage unavailable._',
    ].filter((line) => line !== null).join('\n');
  });
  return {
    relativePath: evidencePageRelativePath(researchId, claim.id),
    content: renderPage({
      frontmatter: {
        type: 'evidence',
        researchId,
        claimId: claim.id,
        claimKind: claim.kind,
        verdict: claim.effectiveVerdict,
        evidenceCount: claim.evidence?.length || 0,
        missingPassages,
        missingSources,
        updated: new Date().toISOString().slice(0, 10),
      },
      body: [`# Evidence for ${claim.id}`, '', claim.text, '', ...blocks].join('\n'),
    }),
  };
}

function buildOpenQuestionsPage(topicTitle, gaps = []) {
  const open = gaps.filter((gap) => gap.status !== 'resolved');
  return {
    relativePath: openQuestionsRelativePath(topicTitle),
    content: renderPage({
      frontmatter: { type: 'open-questions', topic: topicTitle, gapCount: open.length, updated: new Date().toISOString().slice(0, 10) },
      body: [`# ${topicTitle} Open Questions`, '', `Topic: ${wikilinkPath(topicPageRelativePath(topicTitle))}`, '', ...(open.length ? open.map((gap) => `- **${gap.priority || 'normal'}**: ${gap.question} — ${gap.reason || gap.status}`) : ['_No open questions._'])].join('\n'),
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
  claims = [],
  passages = [],
  gaps = [],
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

    const researchClaims = claims
      .filter((claim) => !claim.researchId || claim.researchId === researchId)
      .map(normalizeWikiClaim)
      .filter((claim) => !['source_entry', 'metadata'].includes(claim.kind));
    const claimsPage = buildClaimsPage(topicTitle, report, researchSources, researchClaims, researchId);
    writeVaultFile(path.join(root, claimsPage.relativePath), claimsPage.content);
    topicPages.push(claimsPage.relativePath);

    for (const claim of researchClaims.filter((item) => item.id)) {
      const hash = entityHash(claim);
      const page = buildEvidencePage({ researchId, claim, passages, sources: researchSources });
      if (force || shouldRecompileEntity(manifest, 'claims', claim.id, hash)) {
        writeVaultFile(path.join(root, page.relativePath), page.content);
        summary.compiled += 1;
        summary.pages.push(page.relativePath);
      } else summary.skipped += 1;
      recordEntityCompile(manifest, 'claims', claim.id, hash, [page.relativePath]);
      for (const evidence of claim.evidence || []) {
        const passage = passages.find((item) => item.id === evidence.passageId);
        if (passage) recordEntityCompile(manifest, 'passages', passage.id, entityHash(passage), [page.relativePath]);
      }
      topicPages.push(page.relativePath);
    }

    const researchGaps = gaps.filter((gap) => !gap.researchId || gap.researchId === researchId);
    if (researchGaps.length) {
      const page = buildOpenQuestionsPage(topicTitle, researchGaps);
      writeVaultFile(path.join(root, page.relativePath), page.content);
      topicPages.push(page.relativePath);
      summary.pages.push(page.relativePath);
      for (const gap of researchGaps) recordEntityCompile(manifest, 'gaps', gap.id, entityHash(gap), [page.relativePath]);
    }

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
