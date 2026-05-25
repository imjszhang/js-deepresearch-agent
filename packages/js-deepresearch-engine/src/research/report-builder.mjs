import { reportPrompt } from './prompts.mjs';

export async function buildReport({ llm, query, findings, signal }) {
  if (findings.length === 0) {
    return `# Research Report\n\nNo sources were found for: ${query}`;
  }

  return llm.complete({
    messages: reportPrompt({ query, findings }),
    signal,
    temperature: 0.2,
  });
}
