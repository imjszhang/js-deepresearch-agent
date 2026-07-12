import { reportPrompt, reportRetryPrompt } from './prompts.mjs';

export class ReportGenerationError extends Error {
  constructor({ attempts, minChars, outputChars, diagnostic = null }) {
    const reasoningHint = diagnostic?.hasReasoningContent && !diagnostic?.hasContent
      ? ' The provider returned reasoning metadata but no final content.'
      : '';
    super(`Report generation produced no usable report after ${attempts} attempts (minimum ${minChars} characters; received ${outputChars}).${reasoningHint}`);
    this.name = 'ReportGenerationError';
    this.code = 'REPORT_OUTPUT_INVALID';
    this.attempts = attempts;
    this.minChars = minChars;
    this.outputChars = outputChars;
    this.diagnostic = diagnostic;
  }
}

export function validateReportOutput(report, { minChars = 200 } = {}) {
  const text = String(report || '').trim();
  const flags = [];
  if (!text) flags.push('empty_report');
  else if (text.length < minChars) flags.push('report_too_short');
  if (text && !/^#{1,6}\s+\S+/m.test(text)) flags.push('report_missing_heading');
  return { ok: flags.length === 0, text, outputChars: text.length, flags };
}

export async function buildReport({
  llm,
  query,
  findings,
  signal,
  purpose = 'report',
  limitations = [],
  maxTokens,
  minChars = 200,
  maxAttempts = 2,
  onAttempt = () => {},
}) {
  if (findings.length === 0) {
    return `# Research Report\n\nNo sources were found for: ${query}`;
  }

  let validation = { outputChars: 0, flags: ['empty_report'] };
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted?.();
    onAttempt({ status: 'started', attempt, maxAttempts: attempts });
    const startedAt = Date.now();
    const report = await llm.complete({
      messages: attempt === 1
        ? reportPrompt({ query, findings, limitations })
        : reportRetryPrompt({ query, findings, limitations }),
      signal,
      temperature: attempt === 1 ? 0.2 : 0,
      purpose,
      ...(maxTokens ? { maxTokens } : {}),
    });
    validation = validateReportOutput(report, { minChars });
    const diagnostic = llm.getLastCallMetadata?.() || null;
    onAttempt({
      status: validation.ok ? 'completed' : 'invalid',
      attempt,
      maxAttempts: attempts,
      durationMs: Date.now() - startedAt,
      outputChars: validation.outputChars,
      flags: validation.flags,
      diagnostic,
    });
    if (validation.ok) return validation.text;
  }
  throw new ReportGenerationError({
    attempts,
    minChars,
    outputChars: validation.outputChars,
    diagnostic: llm.getLastCallMetadata?.() || null,
  });
}
