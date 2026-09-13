import { parseStructuredResponse, buildStructuredRetryMessages } from './structured-response.mjs';
import { ReportGenerationError } from './report-builder.mjs';
import { assertKnownStructuredUsage } from './structured-response-usage.mjs';

// Call accounting belongs to the LLM wrapper. Only known, returned structural
// failures enter this bounded retry loop; transport/budget/cancellation errors
// propagate without being relabeled or dispatched again.
export async function completeValidatedStructure({ llm, signal, purpose, researchPhase = null,
  messages, accept, counts, maxTokens }) {
  let providerFailures = 0, parseFailures = 0, attemptMessages = messages;
  for (let attempt = 0; attempt < 4; attempt++) {
    signal?.throwIfAborted?.();
    const raw = await llm.complete({ purpose, signal, messages: attemptMessages, maxTokens });
    signal?.throwIfAborted?.();
    const metadata = llm.getLastCallMetadata?.();
    const result = parseStructuredResponse(raw, { accept, metadata });
    if (result.ok) return result.parsed;
    assertKnownStructuredUsage(metadata);
    const empty = result.reason === 'empty';
    const phase = empty ? 'provider' : 'parse';
    counts[phase]++;
    const exhausted = empty ? ++providerFailures >= 2 : ++parseFailures >= 2;
    if (exhausted) {
      const check = empty ? 'report_empty_output' : 'report_invalid_structure';
      throw new ReportGenerationError({ phase, purpose, researchPhase,
        attempts: Object.values(counts).reduce((sum, count) => sum + count, 0),
        flags: [check], outputChars: String(raw || '').length, attemptCounts: { ...counts },
        failedChecks: [{ check, expected: { passed: true }, actual: { passed: false,
          structuredReason: result.reason, ...result.diagnostics } }],
      });
    }
    attemptMessages = buildStructuredRetryMessages(messages, result.reason);
  }
}
