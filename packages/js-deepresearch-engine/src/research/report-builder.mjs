import { reportPrompt } from './prompts.mjs';

export async function buildReport({ llm, query, findings, signal, purpose = 'report', limitations = [], maxTokens }) {
  if (findings.length === 0) {
    return `# Research Report\n\nNo sources were found for: ${query}`;
  }

  return llm.complete({
    messages: reportPrompt({ query, findings, limitations }),
    signal,
    temperature: 0.2,
    purpose,
    ...(maxTokens ? { maxTokens } : {}),
  });
}
