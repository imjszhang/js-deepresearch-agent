import { positiveInteger } from './strategy-utils.mjs';

/**
 * Maps runner inputs into an explicit strategy context while preserving
 * `settings` for backward-compatible custom strategies.
 *
 * @param {import('../types.mjs').StrategyRunInput} input
 * @returns {import('../types.mjs').StrategyContext}
 */
export function buildStrategyContext({ query, settings, llm, search, signal, emit }) {
  return {
    query,
    iterations: positiveInteger(settings?.research?.iterations, 1),
    questionCount: positiveInteger(settings?.research?.questionsPerIteration, 3),
    concurrency: settings?.research?.concurrency,
    llm,
    search,
    signal,
    emit,
    settings,
  };
}
