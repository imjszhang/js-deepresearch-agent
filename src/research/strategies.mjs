import { generateQuestions } from './question-generator.mjs';

export const strategyRegistry = {
  quick: {
    id: 'quick',
    label: 'Quick',
    description: 'Search the original query once before synthesizing a report.',
    run: runQuick,
  },
  'source-based': {
    id: 'source-based',
    label: 'Source Based',
    description: 'Generate focused research questions and search them sequentially.',
    run: runSourceBased,
  },
  parallel: {
    id: 'parallel',
    label: 'Parallel',
    description: 'Generate focused research questions and search them in parallel.',
    run: runParallel,
  },
};

export const strategyMetadata = Object.values(strategyRegistry).map(({ id, label, description }) => ({
  id,
  label,
  description,
}));

export async function runStrategy({ strategy, ...context }) {
  const entry = strategyRegistry[strategy];
  if (!entry) {
    throw new Error(`Unsupported research strategy: ${strategy}`);
  }
  return entry.run(context);
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
