import { extractJsonObject } from './report-narrative.mjs';

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
    const parsed = extractJsonObject(raw);
    const metadata = lastCallMetadata(llm);
    const truncated = isTruncatedCall(metadata);
    const accepted = accept(parsed) && !truncated;
    return {
      raw,
      parsed,
      metadata,
      truncated,
      accepted,
    };
  };

  const first = await runAttempt(messages, maxTokens);
  if (first.accepted) {
    return {
      ok: true,
      parsed: first.parsed,
      attempts: 1,
      retried: false,
      reason: null,
      metadata: first.metadata,
    };
  }

  const secondMessages = retryMessages || messages;
  const second = await runAttempt(secondMessages, retryMaxTokens);
  if (second.accepted) {
    return {
      ok: true,
      parsed: second.parsed,
      attempts: 2,
      retried: true,
      reason: first.truncated ? 'finish_reason_length' : 'invalid_or_empty_json',
      metadata: second.metadata,
    };
  }

  return {
    ok: false,
    parsed: second.parsed || first.parsed,
    attempts: 2,
    retried: true,
    reason: second.truncated ? 'finish_reason_length' : 'invalid_or_empty_json',
    metadata: second.metadata || first.metadata,
  };
}
