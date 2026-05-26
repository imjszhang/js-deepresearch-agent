import { positiveInteger } from './strategy-utils.mjs';

function withProgressProfile(emit, progressProfile) {
  if (!progressProfile) return emit;

  return function emitWithProgressProfile(input, progress, level) {
    if (input && typeof input === 'object' && typeof input.stage === 'string' && !input.progressProfile) {
      emit({ ...input, progressProfile }, progress, level);
      return;
    }

    emit(input, progress, level);
  };
}

/**
 * Maps runner inputs into an explicit strategy context while preserving
 * `settings` for backward-compatible custom strategies.
 *
 * @param {import('../types.mjs').StrategyRunInput} input
 * @returns {import('../types.mjs').StrategyContext}
 */
export function buildStrategyContext({ query, settings, llm, search, signal, emit, progressProfile }) {
  return {
    query,
    iterations: positiveInteger(settings?.research?.iterations, 1),
    questionCount: positiveInteger(settings?.research?.questionsPerIteration, 3),
    concurrency: settings?.research?.concurrency,
    llm,
    search,
    signal,
    emit: withProgressProfile(emit, progressProfile),
    progressProfile,
    settings,
  };
}
