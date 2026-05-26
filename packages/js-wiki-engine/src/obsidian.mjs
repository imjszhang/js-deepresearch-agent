const INVALID_CHARS = /[<>:"/\\|?*#^\[\]]/g;

export function safeObsidianFilename(title, { maxLength = 120 } = {}) {
  const cleaned = String(title ?? 'Untitled')
    .replace(INVALID_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '');
  const base = cleaned || 'Untitled';
  return base.length > maxLength ? base.slice(0, maxLength).trim() : base;
}

export function wikilink(target, alias = null) {
  const t = String(target ?? '').trim();
  if (!t) return '';
  if (alias) return `[[${t}|${alias}]]`;
  return `[[${t}]]`;
}

/** Wikilink path without .md extension (Obsidian note name). */
export function wikilinkPath(relativePath, alias = null) {
  const withoutExt = String(relativePath).replace(/\.md$/i, '').replace(/\\/g, '/');
  return wikilink(withoutExt, alias);
}

export function pageTitleFromFilename(filename) {
  return safeObsidianFilename(String(filename).replace(/\.md$/i, ''));
}

export function titleCaseQuery(query) {
  return String(query ?? 'Research Topic')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
