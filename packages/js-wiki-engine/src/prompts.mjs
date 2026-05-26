/** Prompt templates for future LLM ingest/query modes. */

export function buildAskPrompt({ question, pages = [] }) {
  const context = pages
    .map((page) => `## ${page.relativePath ?? page.path}\n\n${page.content ?? ''}`)
    .join('\n\n');

  return [
    'Answer the question using only the wiki pages below.',
    'Cite pages using wikilinks when possible.',
    '',
    `Question: ${question}`,
    '',
    'Wiki pages:',
    context,
  ].join('\n');
}

export function buildTopicMergePrompt({ topicTitle, sourceSummaries = [] }) {
  return [
    `Merge the following source summaries into a cohesive topic page for "${topicTitle}".`,
    'Preserve citations and flag contradictions.',
    '',
    ...sourceSummaries.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}
