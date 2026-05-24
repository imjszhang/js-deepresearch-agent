import { generateQuestions } from './question-generator.mjs';

export async function runStrategy({ strategy, query, settings, llm, search, signal, emit }) {
  if (strategy === 'quick') {
    return runQuick({ query, search, signal, emit });
  }
  if (strategy === 'parallel') {
    return runParallel({ query, settings, llm, search, signal, emit });
  }
  return runSourceBased({ query, settings, llm, search, signal, emit });
}

async function runQuick({ query, search, signal, emit }) {
  emit('Searching original query', 20);
  const sources = await search.search(query, { signal });
  return [{ question: query, sources }];
}

async function runSourceBased({ query, settings, llm, search, signal, emit }) {
  const count = settings.research.questionsPerIteration;
  emit('Generating research questions', 10);
  const questions = await generateQuestions({ llm, query, count, signal });
  const findings = [];

  for (const [index, question] of questions.entries()) {
    const progress = 20 + Math.round((index / Math.max(questions.length, 1)) * 50);
    emit(`Searching: ${question}`, progress);
    const sources = await search.search(question, { signal });
    findings.push({ question, sources });
  }

  return findings;
}

async function runParallel({ query, settings, llm, search, signal, emit }) {
  const count = settings.research.questionsPerIteration;
  emit('Generating parallel research questions', 10);
  const questions = await generateQuestions({ llm, query, count, signal });
  emit(`Running ${questions.length} searches in parallel`, 25);

  const results = await Promise.all(
    questions.map(async (question) => ({
      question,
      sources: await search.search(question, { signal }),
    })),
  );

  return results;
}
