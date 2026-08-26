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
        message: resolveMessage(progressProfile.searchStartMessage, event)
          || (event.step && event.maxSteps
            ? `Running ${total} searches for step ${event.step}/${event.maxSteps}`
            : `Running ${total} searches`),
        progress: iteration && iterations
          ? progressBase(iteration, iterations) + 5
          : (event.step && event.maxSteps ? progressBase(event.step, event.maxSteps) + 5 : 25),
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
          || (event.step && event.maxSteps
            ? `Enriching sources for step ${event.step}/${event.maxSteps}`
            : (iteration && iterations
              ? `Enriching sources for iteration ${iteration}/${iterations}`
              : 'Enriching sources')),
        progress: iteration && iterations
          ? progressBase(iteration, iterations) + 8
          : (event.step && event.maxSteps ? progressBase(event.step, event.maxSteps) + 8 : 55),
        level,
      };
    case 'filtering_sources':
      return {
        message: resolveMessage(progressProfile.filteringSourcesMessage, event)
          || 'Filtering sources for relevance',
        progress: 75,
        level,
      };
    case 'assessing_query': return { message: 'Assessing research query', progress: 8, level };
    case 'planning_research': return { message: 'Planning research gaps', progress: 12, level };
    case 'gap_opened': return { message: `Research gap opened: ${event.question || event.gapId}`, progress: null, level };
    case 'gap_resolved': return { message: `Research gap resolved: ${event.question || event.gapId}`, progress: null, level };
    case 'query_skipped_duplicate': return { message: `Skipped duplicate query: ${event.question}`, progress: null, level };
    case 'selecting_sources': return { message: 'Selecting diverse sources', progress: 45, level };
    case 'extracting_passages': return { message: 'Extracting evidence passages', progress: 72, level };
    case 'evaluating_evidence': return { message: 'Evaluating evidence sufficiency', progress: 74, level };
    case 'evaluating_report': return { message: 'Evaluating report claims', progress: 88, level };
    case 'report_retrying': return { message: `Report output was invalid; retrying (${event.attempt}/${event.maxAttempts})`, progress: 82, level: 'warn' };
    case 'llm_call_started': return { message: `LLM call started: ${event.purpose}`, progress: null, level };
    case 'llm_call_finished': return {
      message: `LLM call ${event.status}: ${event.purpose} (${event.durationMs ?? 0}ms, ${event.outputChars ?? 0} chars${event.hasReasoningContent && !event.hasContent ? ', reasoning present but final content empty' : ''})`,
      progress: null,
      level: event.status === 'failed' ? 'error' : level,
    };
    case 'rerank_started': return { message: `Reranking ${event.inputCount || 0} candidate sources`, progress: null, level };
    case 'rerank_completed': return { message: `Rerank completed (${event.provider}, ${event.durationMs ?? 0}ms)`, progress: null, level };
    case 'rerank_degraded': return { message: `Rerank provider degraded to local rules (${event.errorCode})`, progress: null, level: 'warn' };
    case 'research_stopped': return { message: `Research stopped: ${event.reason || 'complete'}`, progress: 78, level };
    case 'budget_exhausted': return { message: `Research budget exhausted: ${event.kind}`, progress: 78, level };
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
