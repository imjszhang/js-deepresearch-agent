export function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set(['what', 'which', 'the', 'are', 'does', 'how', '有什么', '什么', '哪些', '如何', '有哪', '的是']);

export function queryTerms(question) {
  const terms = new Map();
  for (const chunk of normalizeText(question).match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || []) {
    if (/\p{Script=Han}/u.test(chunk)) {
      if (chunk.length === 1) terms.set(chunk, 'han');
      for (let i = 0; i < chunk.length - 1; i += 1) terms.set(chunk.slice(i, i + 2), 'han');
    } else terms.set(chunk, 'word');
  }
  return [...terms].filter(([term]) => !STOP_WORDS.has(term)).map(([term, kind]) => ({ term, kind }));
}

function contains(text, { term, kind }) {
  if (kind === 'han') return text.includes(term);
  const boundary = '[^\\p{L}\\p{N}]|\\p{Script=Han}';
  return new RegExp(`(^|${boundary})${term}($|${boundary})`, 'u').test(text);
}

export function scoreWikiPage(content, question, relativePath = '') {
  const body = normalizeText(content);
  const title = normalizeText(`${relativePath.replace(/\.md$/i, '')} ${(content.match(/^#\s+(.+)$/m) || [])[1] || ''}`);
  const phrase = normalizeText(question);
  const terms = queryTerms(question);
  if (!terms.length) return { score: 0, excerpt: '' };
  let score = 0;
  let hits = 0;
  let titleHit = false;
  const matched = [];
  for (const term of terms) {
    const inTitle = contains(title, term);
    if (!inTitle && !contains(body, term)) continue;
    hits += 1;
    titleHit ||= inTitle;
    matched.push(term.term);
    score += (term.kind === 'word' ? 2 : 1) * (inTitle ? 4 : 1);
  }
  const phraseHit = terms.length === 1 && terms[0].kind === 'word'
    ? contains(body, terms[0]) || contains(title, terms[0])
    : body.includes(phrase) || title.includes(phrase);
  if (phraseHit) score += 20;
  // A lone common character pair in a long question is weak evidence of relevance.
  if (!phraseHit && !titleHit && terms.length > 2 && hits < 2) score = 0;
  if (!score) return { score: 0, excerpt: '' };
  const lines = content.split('\n');
  let offset = 0;
  for (const line of lines) {
    const normalized = normalizeText(line);
    if (matched.some((term) => normalized.includes(term))) break;
    offset += line.length + 1;
  }
  // Locate within a long line too; normalize only for matching, retain the original excerpt.
  const tail = content.slice(offset);
  let normalizedTail = '';
  let originalOffset = 0;
  const offsets = [];
  for (const character of tail) {
    const normalized = character.normalize('NFKC').toLowerCase();
    normalizedTail += normalized;
    for (let index = 0; index < normalized.length; index += 1) offsets.push(originalOffset);
    originalOffset += character.length;
  }
  const positions = matched.map((term) => normalizedTail.indexOf(term)).filter((position) => position >= 0);
  if (positions.length) offset += offsets[Math.min(...positions)];
  const start = Math.max(0, Math.min(offset, content.length) - 100);
  return { score, excerpt: `${start ? '…' : ''}${content.slice(start, start + 400)}${start + 400 < content.length ? '…' : ''}` };
}

export function isSearchableWikiPage(relativePath) {
  return !relativePath.split('/').some((part) => part.startsWith('.') || ['Templates', 'Lint'].includes(part));
}
