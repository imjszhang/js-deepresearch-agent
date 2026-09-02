import { generatePlannedQuestions, userQueryEntry } from '../question-generator.mjs';
import { searchQuestions } from '../search-executor.mjs';
import { resolveStrategyConcurrency, uniqueQuestionCount } from '../strategy-utils.mjs';
import { inferEvidenceScope } from '../adaptive/source-policy.mjs';
import { buildExecutedSearchTrace } from '../search-trace.mjs';
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
    queryMemory,
    settings,
    brief,
    trace = [],
  } = context;
  const followUpCount = Math.min(questionCount, 3);
  const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, followUpCount + 1);

  emit({ stage: 'generating_questions' });
  const followUps = await generatePlannedQuestions({
    llm,
    query,
    count: followUpCount,
    signal,
    mode: 'rapid',
    brief,
    evidenceScope: inferEvidenceScope(settings),
    queryMemory,
  });
  const questions = [userQueryEntry(query), ...followUps];
  addQuickTrace(trace, 'search_query_planned', {
    reasonCode: 'search_query_initial',
    queryOrigin: 'user_query',
    queries: questions.map((item) => item.query),
    plannedQueries: questions,
  });
  const totalQuestions = uniqueQuestionCount(questions.map((item) => item.query));

  emit({ stage: 'searching', total: totalQuestions });
  const findings = await searchQuestions({
    questions,
    search,
    signal,
    concurrency: resolvedConcurrency,
    queryMemory,
    onSkip: ({ question }) => emit({ stage: 'query_skipped_duplicate', question }),
    onResult: (result) => {
      addQuickTrace(trace, 'search', buildExecutedSearchTrace({
        query: result.searchQuery || result.question,
        queryOrigin: result.searchQuery === query || result.question === query ? 'user_query' : 'llm_planner',
        plannerMode: result.searchQuery === query || result.question === query ? null : 'initial',
        plannedQueries: questions.filter((item) => item.query === (result.searchQuery || result.question)),
        searchOptions: result.searchOptions,
        sources: result.sources,
        searchMeta: result.searchMeta,
        resultCount: result.sources?.length || 0,
        skipped: result.skipped || null,
        error: result.error,
        reasonCode: result.skipped || (result.error ? 'search_failed' : 'executed_search'),
      }));
    },
    onProgress: ({ completed, total, question }) => {
      emit({
        stage: 'search_item_complete',
        question,
        completed,
        total,
      });
    },
  });
  return findings.map((finding, index) => ({
    ...finding,
    queryOrigin: index === 0 ? 'user_query' : 'llm_planner',
    plannerMode: index === 0 ? null : 'initial',
  }));
}

function addQuickTrace(trace, action, fields = {}) {
  if (!Array.isArray(trace)) return;
  trace.push({
    step: trace.length + 1,
    action,
    ...fields,
    createdAt: new Date().toISOString(),
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
