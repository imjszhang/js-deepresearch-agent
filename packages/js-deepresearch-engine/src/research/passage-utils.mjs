const MEDIA_ONLY = /^(?:<img\b[^>]*>|!\[[^\]]*\]\([^)]*\))$/i;
export const PASSAGE_CHUNKING_VERSION = 'paragraph-overlap-utf16-v3';

export function tokenOverlapScore(left = '', right = '') {
  const words = (value) => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.min(a.size, b.size);
}

export function stripPassageMarkup(text = '') {
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#*_`>~]+/g, ' ')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function passageSubstance(text = '') {
  return stripPassageMarkup(text).length;
}

export function isMediaOnlyPassage(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (MEDIA_ONLY.test(raw.replace(/\s+/g, ' '))) return true;
  return !stripPassageMarkup(raw);
}

export function isLowValuePassage(text = '') {
  return isMediaOnlyPassage(text);
}

export function compareRankedPassages(left = {}, right = {}) {
  const scoreDelta = (Number(right.retrievalScore) || 0) - (Number(left.retrievalScore) || 0);
  if (scoreDelta !== 0) return scoreDelta;
  return (Number(left.startChar) || 0) - (Number(right.startChar) || 0);
}

export function rankingFocus({ query = '', question = '', title = '', section = '' } = {}) {
  return [query, question, title, section].filter(Boolean).join(' ').trim();
}

function leadingWhitespaceLength(value) {
  const match = String(value || '').match(/^\s*/);
  return match ? match[0].length : 0;
}

// Offsets remain UTF-16 offsets, but a generated boundary must not divide a code point.
function codePointBoundaryBefore(text, offset) {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? offset - 1 : offset;
}

export function splitContentForPassages(content, maxChars = 300) {
  maxChars = Math.max(16, Math.floor(Number(maxChars) || 300));
  const source = String(content || '');
  const chunks = [];
  const paragraphs = source.split(/\n{2,}/);
  let cursor = 0;
  let section = '';
  for (const paragraph of paragraphs) {
    const rawStart = source.indexOf(paragraph, cursor);
    cursor = Math.max(cursor, (rawStart >= 0 ? rawStart : cursor) + paragraph.length);
    let paragraphLead = leadingWhitespaceLength(paragraph);
    let text = paragraph.trim();
    if (!text) continue;
    if (/^#{1,6}\s+/.test(text)) {
      const headingEnd = text.indexOf('\n');
      section = (headingEnd < 0 ? text : text.slice(0, headingEnd)).replace(/^#{1,6}\s+/, '');
      if (headingEnd < 0) continue;
      paragraphLead += headingEnd + 1 + leadingWhitespaceLength(text.slice(headingEnd + 1));
      text = text.slice(headingEnd + 1).trim();
    }
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + maxChars);
      if (end < text.length) {
        const candidate = text.slice(offset, end);
        const boundaries = [...candidate.matchAll(/[.!?。！？；;]\s*|\n/g)];
        const boundary = boundaries.at(-1);
        if (boundary && boundary.index >= maxChars / 2) end = offset + boundary.index + boundary[0].length;
      }
      end = codePointBoundaryBefore(text, end);
      const rawSlice = text.slice(offset, end);
      const sliceLead = leadingWhitespaceLength(rawSlice);
      const value = rawSlice.trim();
      const startChar = Math.max(0, rawStart) + paragraphLead + offset + sliceLead;
      if (!isMediaOnlyPassage(value)) chunks.push({
        text: value,
        startChar,
        endChar: startChar + value.length,
        section,
      });
      if (end === text.length) break;
      const overlap = Math.min(120, Math.floor(maxChars / 6));
      offset = codePointBoundaryBefore(text, Math.max(offset + 1, end - overlap));
    }
  }
  return chunks;
}
