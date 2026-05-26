/**
 * @typedef {import('../types.mjs').ProgressEvent} ProgressEvent
 * @typedef {import('../types.mjs').StrategyProgressEvent} StrategyProgressEvent
 */

export function isStructuredProgressEvent(value) {
  return Boolean(value && typeof value === 'object' && typeof value.stage === 'string');
}

function progressBase(iteration, iterations) {
  return 10 + Math.round(((iteration - 1) / iterations) * 60);
}

/**
 * Maps a structured strategy progress event to the public onProgress shape.
 *
 * @param {StrategyProgressEvent} event
 * @returns {ProgressEvent}
 */
export function mapStructuredProgressEvent(event) {
  const {
    stage,
    strategy,
    iteration,
    iterations,
    completed,
    total,
    question,
    level = 'info',
  } = event;

  switch (stage) {
    case 'research_started':
      return { message: 'Research started', progress: 5, level };
    case 'synthesizing_report':
      return { message: 'Synthesizing report', progress: 80, level };
    case 'research_complete':
      return { message: 'Research complete', progress: 100, level };
    case 'generating_questions':
      if (strategy === 'rapid') {
        return { message: 'Generating rapid follow-up questions', progress: 10, level };
      }
      if (strategy === 'source-based') {
        return {
          message: `Generating research questions for iteration ${iteration}/${iterations}`,
          progress: progressBase(iteration, iterations),
          level,
        };
      }
      if (strategy === 'parallel') {
        return {
          message: `Generating parallel questions for iteration ${iteration}/${iterations}`,
          progress: progressBase(iteration, iterations),
          level,
        };
      }
      break;
    case 'searching':
      if (strategy === 'rapid') {
        return {
          message: `Running ${total} rapid searches`,
          progress: 25,
          level,
        };
      }
      if (strategy === 'source-based') {
        return {
          message: `Searching iteration ${iteration}/${iterations}`,
          progress: progressBase(iteration, iterations) + 5,
          level,
        };
      }
      if (strategy === 'parallel') {
        return {
          message: `Running ${total} parallel searches`,
          progress: progressBase(iteration, iterations) + 5,
          level,
        };
      }
      break;
    case 'search_item_complete':
      return {
        message: `Rapid search complete: ${question}`,
        progress: 25 + Math.round((completed / total) * 45),
        level,
      };
    case 'search_progress':
      return {
        message: strategy === 'parallel'
          ? `Completed ${completed}/${total} parallel searches for iteration ${iteration}`
          : `Completed ${completed}/${total} searches for iteration ${iteration}`,
        progress: progressBase(iteration, iterations) + 5 + Math.round((completed / total) * (50 / iterations)),
        level,
      };
    default:
      break;
  }

  return {
    message: `Research progress: ${stage}`,
    progress: null,
    level,
  };
}

/**
 * Accepts legacy `(message, progress, level)` calls and structured events.
 *
 * @param {(event: ProgressEvent) => void} onProgress
 * @returns {(input: string|StrategyProgressEvent, progress?: number, level?: 'info'|'error') => void}
 */
export function createProgressEmitter(onProgress) {
  return function emit(input, progress, level = 'info') {
    if (isStructuredProgressEvent(input)) {
      onProgress(mapStructuredProgressEvent(input));
      return;
    }

    onProgress({ message: input, progress, level });
  };
}
