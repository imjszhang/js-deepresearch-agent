// Missing metadata on a direct/custom provider is not an assertion about usage.
// The budget wrapper explicitly reports false when an observed call is unknown.
export function assertKnownStructuredUsage(metadata) {
  if (metadata?.usageKnown !== false) return;
  throw Object.assign(new Error('LLM usage is unknown; retain the response and budget reservation before retrying.'),
    { name: 'LlmUsageUnknownError', code: 'LLM_USAGE_UNKNOWN' });
}
