import DOMPurify from 'dompurify';
import { marked } from 'marked';

const renderer = new marked.Renderer();

renderer.link = function link(token) {
  const href = token.href || '';
  const text = token.text || '';
  const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';

  if (href.startsWith('wiki:')) {
    const target = decodeURIComponent(href.slice(5));
    return `<a href="#" class="wiki-link" data-wiki-target="${escapeAttr(target)}"${titleAttr}>${text}</a>`;
  }

  const external = /^https?:\/\//i.test(href);
  const rel = external ? ' rel="noreferrer" target="_blank"' : '';
  return `<a href="${escapeAttr(href)}"${titleAttr}${rel}>${text}</a>`;
};

marked.setOptions({ renderer, gfm: true });

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function stripCodeSpans(markdown) {
  const placeholders = [];
  const masked = String(markdown ?? '').replace(/`[^`]*`|```[\s\S]*?```/g, (segment) => {
    const index = placeholders.length;
    placeholders.push(segment);
    return `\u0000CODE${index}\u0000`;
  });

  return { masked, placeholders };
}

function restoreCodeSpans(text, placeholders) {
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => placeholders[Number(index)] ?? '');
}

export function wikilinksToMarkdownLinks(markdown) {
  const { masked, placeholders } = stripCodeSpans(markdown);
  const linked = masked.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target, alias) => {
      const t = target.trim();
      const label = (alias || target).trim();
      return `[${label}](wiki:${encodeURIComponent(t)})`;
    },
  );
  return restoreCodeSpans(linked, placeholders);
}

export function renderWikiMarkdown(markdown) {
  const prepared = wikilinksToMarkdownLinks(markdown || '');
  const html = marked.parse(prepared);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-wiki-target'],
  });
}
