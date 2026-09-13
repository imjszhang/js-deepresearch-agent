const statuses = new Set(['completed', 'failed', 'cancelled', 'outcome_unknown']);
const reasons = new Set(['stop', 'length', 'max_tokens', 'max_output_tokens', 'content_filter', 'tool_calls', 'function_call', 'load', 'unload', 'other']);
const codes = new Set(['INVALID_PROTOCOL_JSON', 'UNSUPPORTED_CONTENT', 'CANCELLED', 'IDLE_TIMEOUT', 'INVALID_PROTOCOL_SHAPE', 'EVENT_AFTER_TERMINAL', 'PROVIDER_RESPONSE_ERROR', 'UNSUPPORTED_MULTIPLE_CHOICES', 'DUPLICATE_FINISH_EVENT', 'CONFLICTING_USAGE', 'INVALID_CONFIGURATION', 'HEADERS_TIMEOUT', 'TOTAL_TIMEOUT', 'HTTP_ERROR', 'FIRST_EVENT_TIMEOUT', 'MISSING_RESPONSE_BODY', 'INVALID_UTF8', 'UNSUPPORTED_CONTENT_TYPE', 'DUPLICATE_TERMINAL', 'RESPONSE_TOO_LARGE', 'INCOMPLETE_PROTOCOL', 'TRANSPORT_ERROR', 'SANDBOX_EXECUTOR_ERROR']);
const phases = new Set(['configuration', 'queue', 'headers', 'first_event', 'generation', 'total', 'protocol', 'body', 'execution']);
const metricKeys = ['headersMs', 'firstBodyMs', 'firstEventMs', 'firstReasoningMs', 'firstContentMs', 'lastContentMs', 'lastActivityMs', 'totalMs', 'maxActivityGapMs', 'contentChars', 'reasoningChars', 'events', 'bytes'];
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export function safeResult(result = {}) {
  const knownUsage = result.usageKnown === true && ['promptTokens', 'completionTokens', 'totalTokens'].every(key => Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0)
    && result.usage.totalTokens === result.usage.promptTokens + result.usage.completionTokens;
  return {
    status: statuses.has(result.status) ? result.status : 'outcome_unknown',
    transportComplete: result.transportComplete === true, executionResolved: result.executionResolved === true,
    usageKnown: knownUsage, usage: knownUsage ? Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens'].map(key => [key, result.usage[key]])) : null,
    finishReason: result.finishReason == null ? null : reasons.has(result.finishReason) ? result.finishReason : 'other',
    metrics: Object.fromEntries(metricKeys.map(key => [key, number(result.metrics?.[key])])),
    providerMetrics: Object.fromEntries(['totalDurationNs', 'loadDurationNs', 'promptEvalDurationNs', 'evalDurationNs'].map(key => [key, number(result.providerMetrics?.[key])])),
    error: result.error ? { code: codes.has(result.error.code) ? result.error.code : 'SANDBOX_EXECUTOR_ERROR',
      phase: phases.has(result.error.phase) ? result.error.phase : 'execution',
      ...(Number.isInteger(result.error.httpStatus) && result.error.httpStatus >= 100 && result.error.httpStatus <= 599 ? { httpStatus: result.error.httpStatus } : {}) } : null,
  };
}
const types = new Set(['queued', 'sent', 'headers', 'first_body', 'content', 'reasoning', 'finish', 'usage', 'terminal', 'complete', 'dispatch', 'call_finished', 'stopped', 'run_finished']);
const stopReasons = new Set(['cancelled', 'duration_limit', 'outcome_unknown', 'sandbox_error', 'SANDBOX_CANCELLED', 'SANDBOX_QUEUE_TIMEOUT', 'SANDBOX_EXECUTION_UNRESOLVED']);
export function safeEventRecord(event = {}) {
  const row = { type: types.has(event.type) ? event.type : 'other' };
  for (const key of ['elapsedMs', 'chars', 'queueMs', 'promptTokens', 'completionTokens', 'totalTokens']) if (number(event[key]) !== null) row[key] = event[key];
  for (const key of ['callId', 'group']) if (typeof event[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(event[key])) row[key] = event[key];
  if (statuses.has(event.status)) row.status = event.status;
  else if (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599) row.httpStatus = event.status;
  if (reasons.has(event.finishReason)) row.finishReason = event.finishReason;
  if (stopReasons.has(event.reason)) row.reason = event.reason;
  for (const key of ['executionResolved', 'transportComplete', 'structureAccepted', 'usageKnown']) if (typeof event[key] === 'boolean') row[key] = event[key];
  return row;
}
