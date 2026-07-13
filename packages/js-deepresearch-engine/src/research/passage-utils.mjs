export function tokenOverlapScore(left = '', right = '') {
  const words = (value) => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.min(a.size, b.size);
}

export function splitContentForPassages(content, maxChars = 300) {
  const chunks = [];
  const paragraphs = String(content || '').split(/\n{2,}/);
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const text = paragraph.trim();
    const start = String(content).indexOf(paragraph, cursor);
    cursor = Math.max(cursor, start + paragraph.length);
    if (!text || /^(cookie|privacy|navigation|menu)\b/i.test(text)) continue;
    if (/^#{1,6}\s+/.test(text)) continue;
    for (let offset = 0; offset < text.length; offset += maxChars) {
      const value = text.slice(offset, offset + maxChars).trim();
      if (value.length < 40) continue;
      chunks.push({
        text: value,
        startChar: Math.max(0, start) + offset,
        endChar: Math.max(0, start) + offset + value.length,
      });
    }
  }
  return chunks;
}
