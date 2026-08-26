import { generateQuestions } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';
import { runIterativeStrategy } from './iterative.mjs';

export const quickStrategyDefinition = {
  id: 'quick',
  label: '快速调研',
  labelEn: 'Quick research',
  description: '快速了解主题、发现方向；不承诺正文级证据。',
  descriptionEn: 'Fast topic scan and direction-finding; snippet-only, no body-level evidence.',
  requiresLlm: true,
  supportsIterations: true,
  supportsConcurrency: true,
  speed: 'fast',
  depth: 'light',
  progressProfile: {
    generateQuestionsMessage: ({ iteration, iterations }) => (
      iterations > 1
        ? `Generating questions for iteration ${iteration}/${iterations}`
        : 'Generating quick follow-up questions'
    ),
    searchStartMessage: ({ total, iterations }) => (
      iterations > 1
        ? `Running ${total} searches`
        : `Running ${total} quick searches`
    ),
    searchItemCompleteMessage: ({ question }) => `Quick search complete: ${question}`,
    searchItemProgress: ({ completed, total }) => 25 + Math.round((completed / total) * 45),
    searchProgressMessage: ({ completed, total, iteration }) => (
      `Completed ${completed}/${total} searches for iteration ${iteration}`
    ),
  },
};

async function runQuickSingleRound(context) {
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

/** @param {import('../../types.mjs').StrategyContext} context */
export async function runQuick(context) {
  const iterations = Number(context.iterations) || 1;
  if (iterations <= 1) {
    return runQuickSingleRound(context);
  }
  return runIterativeStrategy(context);
}
