import { generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';

export const rapidStrategyDefinition = {
  id: 'rapid',
  label: 'Rapid',
  description: 'Search the original query and a few fast follow-up questions before synthesis.',
  requiresLlm: true,
  supportsIterations: false,
  supportsConcurrency: true,
  speed: 'fast',
  depth: 'light',
};

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runRapid(context) {
  const {
    query,
    questionCount,
    concurrency,
    llm,
    search,
    signal,
    emit,
  } = context;
  const followUpCount = Math.min(questionCount, 3);
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, followUpCount + 1);

  emit('Generating rapid follow-up questions', 10);
  const followUps = await generateQuestions({
    llm,
    query,
    count: followUpCount,
    signal,
    mode: 'rapid',
  });
  const questions = [query, ...followUps];

  emit(`Running ${uniqueQuestionCount(questions)} rapid searches`, 25);
  return searchQuestions({
    questions,
    search,
    signal,
    concurrency: resolvedConcurrency,
    onProgress: ({ completed, total, question }) => {
      emit(`Rapid search complete: ${question}`, 25 + Math.round((completed / total) * 45));
    },
  });
}
