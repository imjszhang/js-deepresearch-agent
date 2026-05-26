import { frontmatter as buildFrontmatter } from './yaml.mjs';

export { buildFrontmatter as frontmatter };
export { buildFrontmatter };

export function renderPage({ frontmatter, body = '' }) {
  const fm = buildFrontmatter(frontmatter);
  const content = String(body ?? '').trim();
  return `${fm}\n\n${content}\n`;
}

/** Wrap literal [[wikilinks]] in backticks so Obsidian/lint do not treat examples as links. */
export function escapeLiteralWikilinks(markdown) {
  return String(markdown ?? '').replace(/\[\[([^\]]+)\]\]/g, '`[[$1]]`');
}

export function extractWikilinks(markdown, { ignoreCode = true } = {}) {
  const body = ignoreCode ? stripCodeSpans(String(markdown ?? '')) : String(markdown ?? '');
  const links = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    links.push({ target: match[1].trim(), alias: match[2]?.trim() ?? null });
  }
  return links;
}

function stripCodeSpans(markdown) {
  return markdown
    .replace(/`[^`]*`/g, (segment) => ' '.repeat(segment.length))
    .replace(/```[\s\S]*?```/g, (segment) => ' '.repeat(segment.length));
}

export function extractSections(markdown) {
  const sections = [];
  const lines = String(markdown ?? '').split('\n');
  let current = { heading: '', lines: [] };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      if (current.heading || current.lines.length) sections.push(current);
      current = { heading: headingMatch[1].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading || current.lines.length) sections.push(current);
  return sections;
}

export function extractClaimLines(reportMarkdown) {
  const claims = [];
  for (const section of extractSections(reportMarkdown)) {
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-') && !trimmed.startsWith('*')) continue;
      const text = trimmed.replace(/^[-*]\s+/, '').trim();
      if (text.length < 20) continue;
      claims.push({
        section: section.heading,
        text,
        hasCitation: /\[\d+\.\d+\]/.test(text),
      });
    }
  }
  return claims.slice(0, 50);
}
