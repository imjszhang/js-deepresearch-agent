import {
  compareRankedPassages,
  rankingFocus,
  splitContentForPassages,
  tokenOverlapScore,
} from './passage-utils.mjs';
import { cosineSimilarity } from './providers/openai-embedding-provider.mjs';
import { isAbortError } from './providers/semantic-provider-errors.mjs';

function buildQueryText(query, question) {
  return [query, question].filter(Boolean).join(' ').trim();
}

function chunkEmbedText(chunk = {}) {
  return String(chunk.text || '').trim();
}

function rankChunksByOverlap({ focus, chunks = [], topK }) {
  return chunks
    .map((chunk) => ({
      ...chunk,
      retrievalScore: tokenOverlapScore(
        rankingFocus({ query: focus, section: chunk.section }),
        chunk.text,
      ),
      rankingMethod: 'overlap',
    }))
    .sort(compareRankedPassages)
    .slice(0, topK);
}

async function scoreChunksByEmbedding({ focus, chunks = [], embedding, signal }) {
  const inputs = [focus, ...chunks.map((chunk) => chunkEmbedText(chunk))];
  const vectors = await embedding.embedDocuments(inputs, { signal, purpose: 'evidence_passages' });
  return chunks.map((chunk, index) => ({
    ...chunk,
    retrievalScore: cosineSimilarity(vectors[0], vectors[index + 1]),
    rankingMethod: 'embedding',
  }));
}

function shouldRethrowRankingError(error) {
  return isAbortError(error) || error?.name === 'BudgetExceededError';
}

export async function rankPassages({
  query = '',
  question = '',
  title = '',
  content = '',
  embedding = null,
  signal,
  topK = 5,
  chunkChars = 1200,
} = {}) {
  const focus = rankingFocus({ query, question, title });
  const chunks = splitContentForPassages(content, chunkChars);
  if (!chunks.length) return [];
  if (embedding?.embedDocuments) {
    try {
      const scored = await scoreChunksByEmbedding({ focus, chunks, embedding, signal });
      return scored.sort(compareRankedPassages).slice(0, topK);
    } catch (error) {
      if (shouldRethrowRankingError(error)) throw error;
    }
  }
  return rankChunksByOverlap({ focus, chunks, topK });
}

function selectByOverlap({ query, question, content, topK, chunkChars }) {
  const focus = buildQueryText(query, question);
  return rankChunksByOverlap({
    focus,
    chunks: splitContentForPassages(content, chunkChars),
    topK,
  }).map((passage) => passage.text);
}

function rankWindowScores(chunkScores, windowChunks) {
  const windowSize = Math.max(1, Number(windowChunks) || 20);
  const windows = [];
  for (let start = 0; start < chunkScores.length; start += 1) {
    const slice = chunkScores.slice(start, start + windowSize);
    if (!slice.length) continue;
    const score = slice.reduce((sum, item) => sum + (Number(item.score ?? item.retrievalScore) || 0), 0) / slice.length;
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
    const scored = await scoreChunksByEmbedding({ focus, chunks, embedding, signal });
    const chunkScores = scored.map((chunk) => ({ ...chunk, score: chunk.retrievalScore }));
    const windows = rankWindowScores(chunkScores, windowChunks);
    const passages = passagesFromWindows(chunks, windows, topK);
    if (passages.length) return passages.map((passage, index) => `<snippet-${index + 1}>\n${passage}\n</snippet-${index + 1}>`).join('\n\n');
  } catch (error) {
    if (shouldRethrowRankingError(error)) throw error;
  }

  const overlapPassages = selectByOverlap({ query, question, content: text, topK, chunkChars });
  return overlapPassages.join('\n\n') || String(snippet || '').trim() || text.slice(0, shortContentChars);
}
