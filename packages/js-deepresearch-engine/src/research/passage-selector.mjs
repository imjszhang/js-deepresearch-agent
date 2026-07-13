import { splitContentForPassages, tokenOverlapScore } from './passage-utils.mjs';
import { cosineSimilarity } from './providers/openai-embedding-provider.mjs';

function buildQueryText(query, question) {
  return [query, question].filter(Boolean).join(' ').trim();
}

function selectByOverlap({ query, question, content, topK, chunkChars }) {
  const focus = buildQueryText(query, question);
  return splitContentForPassages(content, chunkChars)
    .map((passage) => ({ ...passage, score: tokenOverlapScore(focus, passage.text) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map((passage) => passage.text);
}

function rankWindowScores(chunkScores, windowChunks) {
  const windowSize = Math.max(1, Number(windowChunks) || 20);
  const windows = [];
  for (let start = 0; start < chunkScores.length; start += 1) {
    const slice = chunkScores.slice(start, start + windowSize);
    if (!slice.length) continue;
    const score = slice.reduce((sum, item) => sum + item.score, 0) / slice.length;
    windows.push({ start, end: start + slice.length - 1, score });
  }
  return windows.sort((left, right) => right.score - left.score);
}

function passagesFromWindows(chunks, windows, topK) {
  const selected = [];
  const used = new Set();
  for (const window of windows) {
    if (selected.length >= topK) break;
    if ([...Array(window.end - window.start + 1).keys()].some((offset) => used.has(window.start + offset))) continue;
    const text = chunks.slice(window.start, window.end + 1).map((chunk) => chunk.text).join('\n').trim();
    if (!text) continue;
    for (let index = window.start; index <= window.end; index += 1) used.add(index);
    selected.push(text);
  }
  return selected;
}

export async function selectRelevantPassages({
  query,
  question = '',
  content = '',
  snippet = '',
  embedding = null,
  signal,
  topK = 3,
  chunkChars = 300,
  windowChunks = 20,
  shortContentChars = 600,
} = {}) {
  const text = String(content || '').trim();
  if (!text) return String(snippet || '').trim();
  if (text.length <= shortContentChars) return text;

  const focus = buildQueryText(query, question);
  const chunks = splitContentForPassages(text, chunkChars);
  if (!chunks.length) return text.slice(0, shortContentChars);

  if (!embedding?.embedDocuments) {
    const overlapPassages = selectByOverlap({ query, question, content: text, topK, chunkChars });
    return overlapPassages.join('\n\n') || text.slice(0, shortContentChars);
  }

  try {
    const inputs = [focus, ...chunks.map((chunk) => chunk.text)];
    const vectors = await embedding.embedDocuments(inputs, { signal });
    const queryVector = vectors[0];
    const chunkScores = chunks.map((chunk, index) => ({
      ...chunk,
      score: cosineSimilarity(queryVector, vectors[index + 1]),
    }));
    const windows = rankWindowScores(chunkScores, windowChunks);
    const passages = passagesFromWindows(chunks, windows, topK);
    if (passages.length) return passages.map((passage, index) => `<snippet-${index + 1}>\n${passage}\n</snippet-${index + 1}>`).join('\n\n');
  } catch {
    // Fall back to deterministic overlap when embedding is unavailable.
  }

  const overlapPassages = selectByOverlap({ query, question, content: text, topK, chunkChars });
  return overlapPassages.join('\n\n') || String(snippet || '').trim() || text.slice(0, shortContentChars);
}
