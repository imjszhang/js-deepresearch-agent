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

function resolveMessage(template, event) {
  if (typeof template === 'function') return template(event);
  if (typeof template === 'string') return template;
  return null;
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
    iteration,
    iterations,
    completed,
    total,
    level = 'info',
    progressProfile = {},
  } = event;

  switch (stage) {
    case 'research_started':
      return { message: 'Research started', progress: 5, level };
    case 'synthesizing_report':
      return { message: 'Synthesizing report', progress: 80, level };
    case 'research_complete':
      return { message: 'Research complete', progress: 100, level };
    case 'generating_questions':
      return {
        message: resolveMessage(progressProfile.generateQuestionsMessage, event) || 'Generating research questions',
        progress: iteration && iterations ? progressBase(iteration, iterations) : 10,
        level,
      };
    case 'searching':
      return {
        message: resolveMessage(progressProfile.searchStartMessage, event) || `Running ${total} searches`,
        progress: iteration && iterations ? progressBase(iteration, iterations) + 5 : 25,
        level,
      };
    case 'search_item_complete':
      return {
        message: resolveMessage(progressProfile.searchItemCompleteMessage, event) || `Search complete: ${event.question}`,
        progress: typeof progressProfile.searchItemProgress === 'function'
          ? progressProfile.searchItemProgress(event)
          : 25 + Math.round((completed / total) * 45),
        level,
      };
    case 'search_progress':
      return {
        message: resolveMessage(progressProfile.searchProgressMessage, event)
          || `Completed ${completed}/${total} searches for iteration ${iteration}`,
        progress: progressBase(iteration, iterations) + 5 + Math.round((completed / total) * (50 / iterations)),
        level,
      };
    case 'enriching_sources':
      return {
        message: resolveMessage(progressProfile.enrichingSourcesMessage, event)
          || `Enriching sources for iteration ${iteration}/${iterations}`,
        progress: iteration && iterations ? progressBase(iteration, iterations) + 8 : 55,
        level,
      };
    case 'filtering_sources':
      return {
        message: resolveMessage(progressProfile.filteringSourcesMessage, event)
          || 'Filtering sources for relevance',
        progress: 75,
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
