const MEDIA_ONLY = /^(?:<img\b[^>]*>|!\[[^\]]*\]\([^)]*\))$/i;

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

export function splitContentForPassages(content, maxChars = 300) {
  const chunks = [];
  const paragraphs = String(content || '').split(/\n{2,}/);
  let cursor = 0;
  let section = '';
  for (const paragraph of paragraphs) {
    const text = paragraph.trim();
    const start = String(content).indexOf(paragraph, cursor);
    cursor = Math.max(cursor, start + paragraph.length);
    if (!text) continue;
    if (/^#{1,6}\s+/.test(text)) {
      section = text.replace(/^#{1,6}\s+/, '');
      continue;
    }
    for (let offset = 0; offset < text.length; offset += maxChars) {
      const value = text.slice(offset, offset + maxChars).trim();
      if (isMediaOnlyPassage(value)) continue;
      chunks.push({
        text: value,
        startChar: Math.max(0, start) + offset,
        endChar: Math.max(0, start) + offset + value.length,
        section,
      });
    }
  }
  return chunks;
}
