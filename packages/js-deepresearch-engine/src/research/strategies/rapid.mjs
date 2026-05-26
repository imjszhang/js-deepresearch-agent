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
  progressProfile: {
    generateQuestionsMessage: () => 'Generating rapid follow-up questions',
    searchStartMessage: ({ total }) => `Running ${total} rapid searches`,
    searchItemCompleteMessage: ({ question }) => `Rapid search complete: ${question}`,
    searchItemProgress: ({ completed, total }) => 25 + Math.round((completed / total) * 45),
  },
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

  emit({ stage: 'generating_questions' });
  const followUps = await generateQuestions({
    llm,
    query,
    count: followUpCount,
    signal,
    mode: 'rapid',
  });
  const questions = [query, ...followUps];
  const totalQuestions = uniqueQuestionCount(questions);

  emit({ stage: 'searching', total: totalQuestions });
  return searchQuestions({
    questions,
    search,
    signal,
    concurrency: resolvedConcurrency,
    onProgress: ({ completed, total, question }) => {
      emit({
        stage: 'search_item_complete',
        question,
        completed,
        total,
      });
    },
  });
}
