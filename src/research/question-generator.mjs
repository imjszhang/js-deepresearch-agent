import { questionPrompt } from './prompts.mjs';

export async function generateQuestions({ llm, query, count, signal }) {
  const raw = await llm.complete({
    messages: questionPrompt(query, count),
    signal,
    temperature: 0.1,
  });

  const parsed = parseJsonArray(raw);
  if (parsed.length > 0) {
    return parsed.slice(0, count);
  }

  return [query];
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
