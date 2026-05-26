import { extractWikilinks } from './markdown.mjs';
import { listMarkdownPages, readPage, resolveVaultDir } from './vault.mjs';

function scorePage(content, question) {
  const q = question.toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 2);
  const lower = content.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += 1;
  }
  if (lower.includes(q)) score += 5;
  return score;
}

export async function askWiki({ vaultDir, question, llm = null, limit = 5 } = {}) {
  if (!question?.trim()) {
    throw new Error('askWiki requires a question');
  }

  const root = resolveVaultDir(vaultDir);
  const pages = listMarkdownPages(root)
    .map((page) => ({
      ...page,
      content: readPage(root, page.relativePath) ?? '',
      score: scorePage(readPage(root, page.relativePath) ?? '', question),
    }))
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!llm) {
    return {
      mode: 'retrieval',
      question,
      pages: pages.map((p) => ({
        relativePath: p.relativePath,
        score: p.score,
        excerpt: p.content.slice(0, 400),
      })),
      answer: pages.length
        ? `Found ${pages.length} related page(s). Open them in Obsidian for details.`
        : 'No related pages found in the vault.',
    };
  }

  const context = pages.map((p) => `## ${p.relativePath}\n\n${p.content.slice(0, 2000)}`).join('\n\n');
  const prompt = [
    'Answer the question using only the wiki pages below.',
    'Cite pages using wikilinks when possible.',
    '',
    `Question: ${question}`,
    '',
    'Wiki pages:',
    context,
  ].join('\n');

  const complete = llm.complete ?? llm.chat;
  if (typeof complete !== 'function') {
    throw new Error('llm must provide complete() or chat()');
  }
  const answer = await complete.call(llm, prompt);
  return {
    mode: 'llm',
    question,
    pages: pages.map((p) => p.relativePath),
    answer,
  };
}

export function collectOutgoingLinks(vaultDir, relativePath) {
  const content = readPage(resolveVaultDir(vaultDir), relativePath);
  if (!content) return [];
  return extractWikilinks(content);
}
