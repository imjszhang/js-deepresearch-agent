import { assertKnownStructuredUsage } from './structured-response-usage.mjs';
import { extractJsonObject, parseStructuredResponse, buildStructuredRetryMessages } from './structured-response.mjs';

export { extractJsonObject };

export function lastCallMetadata(llm) {
  return llm?.getLastCallMetadata?.() || null;
}

export function isTruncatedCall(metadata) {
  return String(metadata?.finishReason || '').toLowerCase() === 'length';
}

export function hasUsablePlannerPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.requiredAnswerSlots) && parsed.requiredAnswerSlots.length > 0) return true;
  if (Array.isArray(parsed.gaps) && parsed.gaps.length > 0) return true;
  if (Array.isArray(parsed.requiredHosts) && parsed.requiredHosts.length > 0) return true;
  if (Array.isArray(parsed.requiredSourceTypes) && parsed.requiredSourceTypes.length > 0) return true;
  return false;
}

export async function completeStructuredJson({
  llm,
  signal,
  purpose,
  messages,
  retryMessages,
  maxTokens = 1200,
  retryMaxTokens = 800,
  temperature = 0,
  accept = hasUsablePlannerPayload,
} = {}) {
  if (!llm?.complete) {
    return { ok: false, parsed: null, attempts: 0, retried: false, reason: 'no_llm' };
  }

  const runAttempt = async (attemptMessages, tokens) => {
    const raw = await llm.complete({
      purpose,
      signal,
      temperature,
      maxTokens: tokens,
      messages: attemptMessages,
    });
    const metadata = lastCallMetadata(llm);
    const result = parseStructuredResponse(raw, { accept, metadata });
    if (!result.ok) assertKnownStructuredUsage(metadata);
    return { ...result, metadata };
  };

  // Preserve public reason codes; parseReason and diagnostics identify the
  // structural failure without persisting model prose.
  const legacyReason = (reason) => reason === 'truncated'
    ? 'finish_reason_length' : 'invalid_or_empty_json';

  const first = await runAttempt(messages, maxTokens);
  if (first.ok) {
    return {
      ok: true,
      parsed: first.parsed,
      attempts: 1,
      retried: false,
      reason: null,
      parseReason: null,
      diagnostics: first.diagnostics,
      metadata: first.metadata,
    };
  }

  const secondMessages = buildStructuredRetryMessages(retryMessages || messages, first.reason);
  const second = await runAttempt(secondMessages, retryMaxTokens);
  if (second.ok) {
    return {
      ok: true,
      parsed: second.parsed,
      attempts: 2,
      retried: true,
      reason: legacyReason(first.reason),
      parseReason: first.reason,
      diagnostics: second.diagnostics,
      metadata: second.metadata,
    };
  }

  return {
    ok: false,
    parsed: second.parsed,
    attempts: 2,
    retried: true,
    reason: legacyReason(second.reason),
    parseReason: second.reason,
    diagnostics: second.diagnostics,
    metadata: second.metadata || first.metadata,
  };
}
