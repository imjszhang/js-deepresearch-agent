import { getSourceEvidence } from './source-based-settings.mjs';

export function formatSourcesForResearchContext(findings = [], {
  limit = 30,
  charsPerSource = 500,
} = {}) {
  const sources = [];

  for (const finding of findings) {
    for (const source of finding?.sources || []) {
      sources.push(source);
    }
  }

  return sources.slice(-limit).map((source, index) => {
    const title = source.title || 'Untitled';
    const url = source.url || '';
    const evidence = getSourceEvidence(source);
    const snippet = evidence.length > charsPerSource
      ? `${evidence.slice(0, charsPerSource)}...`
      : evidence;

    return `Source ${index + 1}: ${title}\nURL: ${url}\nEvidence: ${snippet}`;
  }).join('\n\n');
}
