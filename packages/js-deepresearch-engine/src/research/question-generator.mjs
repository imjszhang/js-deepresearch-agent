import { questionPrompt } from './prompts.mjs';

export async function generateQuestions({ llm, query, count, signal, mode = 'initial', context = '' }) {
  const raw = await llm.complete({
    messages: questionPrompt({ query, count, mode, context }),
    signal,
    temperature: 0.1,
  });

  const parsed = parseJsonArray(raw);
  if (parsed.length > 0) {
    return parsed.slice(0, count);
  }

  return [query];
}

export function formatSourcesForQuestionContext(findings, limit = 12) {
  const sources = [];
  for (const finding of findings || []) {
    for (const source of finding.sources || []) {
      sources.push(source);
    }
  }

  return sources.slice(-limit).map((source, index) => {
    const title = source.title || 'Untitled';
    const url = source.url || '';
    const snippet = source.snippet || '';
    return `Source ${index + 1}: ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  }).join('\n\n');
}

function parseJsonArray(raw) {
  const trimmed = raw.trim();
  const jsonText = trimmed.match(/\[[\s\S]*\]/)?.[0] || trimmed;
  try {
    const value = JSON.parse(jsonText);
    if (Array.isArray(value)) {
      return value.map(String).map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}
