import { createHash } from 'node:crypto';
import { reportPrompt, reportRetryPrompt, reportRevisionRetryPrompt } from './prompts.mjs';
import { parseCitations, parseInternalReferenceTokens } from './citations.mjs';
import { classifyClaimSection } from './claim-quality.mjs';
import {
  containsSourceDump,
  parseMarkdownNarrative,
  parseNarrativeResponse,
  renderNarrativeMarkdown,
  sanitizeNarrativeResponse,
} from './report-narrative.mjs';

const LABELED_NARRATIVE_HEADING = /^(summary|executive summary|key findings|findings|confirmed background facts|background facts|摘要|总结|概述|关键发现|核心发现|主要发现|已确认背景事实|背景事实)\b/i;
const REASONING_TOKEN = /<\/?think\b[^>]*>/gi;
const RENDER_FLAGS = new Set([
  'report_internal_reference_token',
  'report_reasoning_token',
  'report_empty_bullets',
]);

export const REPORT_FAILURE_PHASES = Object.freeze([
  'provider',
  'parse',
  'semantic-contract',
  'render',
]);

const SAFE_DIAGNOSTIC_KEYS = new Set([
  'passed',
  'nonEmpty',
  'characters',
  'minimumCharacters',
  'markdownHeadings',
  'minimumMarkdownHeadings',
  'truncated',
  'lastContentLength',
  'lastContentSha256',
  'endingCategory',
  'sourceDumpDetected',
  'significantCharacters',
  'minimumSignificantCharacters',
  'sectionPresent',
  'unresolvedCitationCount',
  'unresolvedCitationSetSha256',
  'internalReferenceTokenCount',
  'internalReferenceKind',
  'reasoningTokenCount',
  'emptyBulletLines',
  'validStructuredNarrative',
  'minimumKeyClaims',
  'keyClaims',
  'minimumRequiredSlotClaimsInKeyFindings',
  'requiredSlotClaims',
  'requiredSlotClaimsInKeyFindings',
  'minimumBoundClaims',
  'boundClaims',
  'slotIndex',
  'slotIdSha256',
  'supportable',
  'quoteAnchored',
  'citationCount',
]);
const SAFE_DIAGNOSTIC_ENUMS = new Set([
  'gap',
  'empty',
  'citation',
  'terminal_punctuation',
  'long_unpunctuated',
  'short_unpunctuated',
]);

function diagnosticHash(value = '') {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sanitizeDiagnosticValue(value, key = '') {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (key.endsWith('Sha256') && /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
    if ((key === 'endingCategory' || key === 'internalReferenceKind') && SAFE_DIAGNOSTIC_ENUMS.has(value)) {
      return value;
    }
    return { characters: value.length, sha256: diagnosticHash(value) };
  }
  if (Array.isArray(value)) {
    return { count: value.length, sha256: diagnosticHash(JSON.stringify(value)) };
  }
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([childKey]) => SAFE_DIAGNOSTIC_KEYS.has(childKey))
      .map(([childKey, childValue]) => [
        childKey,
        sanitizeDiagnosticValue(childValue, childKey),
      ]),
  );
}

export function sanitizeReportFailedChecks(failedChecks = [], { phase = null } = {}) {
  const safePhase = REPORT_FAILURE_PHASES.includes(phase) ? phase : null;
  return (Array.isArray(failedChecks) ? failedChecks : []).map((item) => ({
    check: /^[a-z0-9_:-]{1,96}$/i.test(String(item?.check || ''))
      ? String(item.check)
      : 'unknown_report_check',
    ...(safePhase ? { phase: safePhase } : {}),
    expected: sanitizeDiagnosticValue(item?.expected),
    actual: sanitizeDiagnosticValue(item?.actual),
  }));
}

function formatCheckValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatFailedChecks(failedChecks = []) {
  if (!failedChecks.length) return 'none recorded';
  return failedChecks.map(({ check, expected, actual }) => (
    `${check} (expected: ${formatCheckValue(expected)}; actual: ${formatCheckValue(actual)})`
  )).join('; ');
}

function fallbackFailedChecks(flags = [], { minChars, outputChars } = {}) {
  return [...new Set(flags)].map((check) => ({
    check,
    expected: check === 'report_too_short' || check === 'report_short_narrative'
      ? { minimumCharacters: minChars }
      : { passed: true },
    actual: check === 'report_too_short' || check === 'report_short_narrative'
      ? { characters: outputChars }
      : { passed: false },
  }));
}

export function extractLabeledNarrativeText(report = '') {
  const parts = [];
  let current = null;
  let include = false;
  let labeledLevel = 0;
  for (const line of String(report || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (LABELED_NARRATIVE_HEADING.test(title)) {
        current = { heading: title, body: [] };
        parts.push(current);
        include = true;
        labeledLevel = level;
        continue;
      }
      if (include && current && level > labeledLevel) {
        current.body.push(line);
        continue;
      }
      include = false;
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  return parts
    .map((part) => part.body.join('\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

export class ReportGenerationError extends Error {
  constructor({
    attempts,
    minChars,
    outputChars,
    diagnostic = null,
    flags = [],
    failedChecks = [],
    phase = null,
    contract = null,
    attemptCounts = null,
  }) {
    const reasoningHint = diagnostic?.hasReasoningContent && !diagnostic?.hasContent
      ? ' The provider returned reasoning metadata but no final content.'
      : '';
    const unsafeChecks = failedChecks.length
      ? failedChecks
      : fallbackFailedChecks(flags, { minChars, outputChars });
    const safePhase = REPORT_FAILURE_PHASES.includes(phase) ? phase : null;
    const phaseLabel = safePhase || 'unknown';
    const normalizedChecks = sanitizeReportFailedChecks(unsafeChecks, { phase: safePhase });
    super(`Report generation failed after ${attempts} report attempts during ${phaseLabel}. Failing checks: ${formatFailedChecks(normalizedChecks)}.${reasoningHint}`);
    this.name = 'ReportGenerationError';
    this.code = 'REPORT_OUTPUT_INVALID';
    this.attempts = attempts;
    this.minChars = minChars;
    this.outputChars = outputChars;
    this.diagnostic = diagnostic;
    this.flags = flags;
    this.failedChecks = normalizedChecks;
    this.phase = safePhase;
    this.contract = contract;
    this.attemptCounts = attemptCounts || null;
  }
}

const REQUIRED_FULL_GROUPS = {
  narrative: ['key_claim'],
  evidence: ['evidence_entry'],
  caveats: ['caveat'],
  sources: ['source_entry'],
};

const GENERATED_SECTION_KINDS = new Set(['evidence_entry', 'source_entry', 'caveat']);

function headingsOf(report) {
  return String(report || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function hasSectionKind(report, kinds) {
  const wanted = new Set(kinds);
  return headingsOf(report).some((heading) => wanted.has(classifyClaimSection(heading)));
}

function lastContentLine(report) {
  const lines = String(report || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^[-*]{3,}$/.test(line));
  return lines.at(-1) || '';
}

export function looksTruncated(report) {
  const last = lastContentLine(report).replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
  if (!last) return true;
  if (/支持\s+\d+\.$/.test(last) || /[A-Za-z\u4e00-\u9fff]\s+\d+\.$/.test(last)) return true;
  if (/\[\d+\.\d+(?:\s*[-,，]\s*\d+\.\d+)*\]$/.test(last)) return false;
  if (/[.!?。！？]"?$/.test(last)) return false;
  if (/[.!?。！？]\s*\[[0-9.]+\]$/.test(last)) return false;
  return last.length > 24;
}

function endingCategory(line = '') {
  const last = String(line || '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
  if (!last) return 'empty';
  if (/\[\d+\.\d+(?:\s*[-,，]\s*\d+\.\d+)*\]$/.test(last)) return 'citation';
  if (/[.!?。！？]"?$/.test(last)) return 'terminal_punctuation';
  return last.length > 24 ? 'long_unpunctuated' : 'short_unpunctuated';
}

function textBeforeGeneratedSections(report = '') {
  const kept = [];
  for (const line of String(report || '').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading && GENERATED_SECTION_KINDS.has(classifyClaimSection(heading[1].trim()))) break;
    kept.push(line);
  }
  return kept.join('\n');
}

const SUMMARY_HEADINGS = new Set(['summary', 'executive summary', '摘要', '总结', '概述']);

function isSummaryHeading(title = '') {
  const normalized = String(title).normalize('NFKC').trim().toLowerCase().replace(/[：:]$/, '');
  return SUMMARY_HEADINGS.has(normalized) || [...SUMMARY_HEADINGS].some((alias) => (
    normalized.startsWith(`${alias}:`) || normalized.startsWith(`${alias}：`)
  ));
}

function summarySectionBody(report) {
  const lines = String(report || '').split(/\r?\n/);
  const body = [];
  let capture = false;
  let captureLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      if (isSummaryHeading(heading[2].trim())) {
        capture = true;
        captureLevel = level;
        continue;
      }
      if (capture && level <= captureLevel) break;
    }
    if (capture) body.push(line);
  }
  return body.join('\n');
}

function significantTextLength(text = '') {
  return String(text)
    .replace(/[#*_`[\]()>]/g, '')
    .replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '')
    .length;
}

export function isPlaceholderSummary(text = '') {
  return significantTextLength(text) < 12;
}

function unresolvedCitations(report, findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const keys = parseCitations(report);
  return keys.filter((key) => {
    const [findingIndex, sourceIndex] = key.split('.').map(Number);
    const finding = findings[findingIndex - 1];
    return !finding?.sources?.[sourceIndex - 1];
  });
}

export function validateReportOutput(report, {
  minChars = 200,
  mode = 'narrative',
  findings = [],
} = {}) {
  const text = String(report || '').trim();
  const failedChecks = [];
  const fail = (check, expected, actual) => failedChecks.push({ check, expected, actual });
  if (!text) fail('empty_report', { nonEmpty: true }, { characters: 0 });
  else if (mode !== 'full' && text.length < minChars) {
    fail('report_too_short', { minimumCharacters: minChars }, { characters: text.length });
  }
  const headings = headingsOf(text);
  if (text && headings.length === 0) {
    fail('report_missing_heading', { minimumMarkdownHeadings: 1 }, { markdownHeadings: 0 });
  }
  if (text && mode === 'narrative' && looksTruncated(text)) {
    const last = lastContentLine(text);
    fail('report_truncated', { truncated: false }, {
      truncated: true,
      lastContentLength: last.length,
      lastContentSha256: diagnosticHash(last),
      endingCategory: endingCategory(last),
    });
  }
  const narrativeText = mode === 'full' ? textBeforeGeneratedSections(text) : text;
  const labeled = extractLabeledNarrativeText(narrativeText);
  if (text && labeled.length < minChars) {
    fail('report_short_narrative', { minimumCharacters: minChars }, { characters: labeled.length });
  }
  if (text && containsSourceDump(narrativeText)) {
    fail('report_contains_source_dump', { sourceDumpDetected: false }, { sourceDumpDetected: true });
  }
  const summaryBody = summarySectionBody(narrativeText);
  if (text && isPlaceholderSummary(summaryBody)) {
    fail('report_empty_summary', { minimumSignificantCharacters: 12 }, {
      significantCharacters: significantTextLength(summaryBody),
    });
  }
  if (mode === 'full') {
    if (!hasSectionKind(text, REQUIRED_FULL_GROUPS.narrative)) {
      fail('report_missing_summary_or_findings', { sectionPresent: true }, { sectionPresent: false });
    }
    if (!/^#{1,6}\s+(Evidence|证据)\b/im.test(text)) {
      fail('report_missing_evidence', { sectionPresent: true }, { sectionPresent: false });
    }
    if (!hasSectionKind(text, ['source_entry'])) {
      fail('report_missing_sources', { sectionPresent: true }, { sectionPresent: false });
    }
    if (!hasSectionKind(text, ['caveat'])) {
      fail('report_missing_caveats', { sectionPresent: true }, { sectionPresent: false });
    }
  }
  const dangling = unresolvedCitations(text, findings);
  if (dangling.length) {
    fail('report_unresolved_citations', { unresolvedCitationCount: 0 }, {
      unresolvedCitationCount: dangling.length,
      unresolvedCitationSetSha256: diagnosticHash([...dangling].sort().join(',')),
    });
  }
  const internalTokens = parseInternalReferenceTokens(text);
  if (internalTokens.length) {
    fail('report_internal_reference_token', { internalReferenceTokenCount: 0 }, {
      internalReferenceTokenCount: internalTokens.length,
      internalReferenceKind: 'gap',
    });
  }
  const reasoningTokens = [...new Set(text.match(REASONING_TOKEN) || [])];
  if (reasoningTokens.length) {
    fail('report_reasoning_token', { reasoningTokenCount: 0 }, {
      reasoningTokenCount: reasoningTokens.length,
    });
  }
  const emptyBullets = emptyBulletLines(text);
  if (emptyBullets.length) {
    fail('report_empty_bullets', { emptyBulletLines: 0 }, { emptyBulletLines: emptyBullets.length });
  }
  const flags = failedChecks.map((item) => item.check);
  return {
    ok: flags.length === 0,
    text,
    outputChars: text.length,
    flags,
    failedChecks,
    measurements: {
      characters: text.length,
      labeledNarrativeCharacters: labeled.length,
      summarySignificantCharacters: significantTextLength(summaryBody),
      markdownHeadings: headings.length,
    },
  };
}

export function emptyBulletLines(report = '') {
  return String(report || '').split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s*$/.test(line));
}

function genericFailedCheck(check, actual = { passed: false }) {
  return { check, expected: { passed: true }, actual };
}

function mergeValidationChecks(...validations) {
  const byCheck = new Map();
  for (const validation of validations) {
    for (const item of validation?.failedChecks || []) {
      if (!byCheck.has(item.check)) byCheck.set(item.check, item);
    }
  }
  return [...byCheck.values()];
}

function withParserFlags(validation, flags = []) {
  const failedChecks = mergeValidationChecks(validation);
  const existing = new Set(failedChecks.map((item) => item.check));
  for (const flag of flags) {
    if (!existing.has(flag)) failedChecks.push(genericFailedCheck(flag));
  }
  return {
    ...validation,
    ok: failedChecks.length === 0,
    flags: failedChecks.map((item) => item.check),
    failedChecks,
  };
}

export function classifyReportFailurePhase(validation) {
  return validation.flags?.every((flag) => RENDER_FLAGS.has(flag))
    ? 'render'
    : 'semantic-contract';
}

export function looksLikeStructuredNarrative(text = '') {
  const value = String(text || '').trim();
  if (/```json\b[\s\S]*?\{/i.test(value)) return true;
  const objectStart = value.indexOf('{');
  if (objectStart < 0) return false;
  const objectCandidate = value.slice(objectStart);
  const fields = new Set(
    [...objectCandidate.matchAll(/"(title|summary|backgroundFacts|confirmedBackgroundFacts|keyFindings|caveats)"\s*:/g)]
      .map((match) => match[1]),
  );
  return fields.has('title') && (
    fields.has('summary')
    || fields.has('keyFindings')
    || fields.has('backgroundFacts')
    || fields.has('confirmedBackgroundFacts')
    || fields.has('caveats')
  );
}

export async function buildReport({
  llm,
  query,
  findings,
  signal,
  purpose = 'report',
  limitations = [],
  strategy = 'focused',
  passages = [],
  maxPassageChars,
  maxTokens,
  minChars = 200,
  maxAttempts = 2,
  mode = 'narrative',
  onAttempt = () => {},
  gaps = [],
  brief = {},
  contract = null,
  retryContext = null,
}) {
  if (findings.length === 0) {
    const text = `# Research Report\n\nNo sources were found for: ${query}`;
    return {
      text,
      document: parseMarkdownNarrative(text),
      origin: 'empty_findings',
      diagnostics: { flags: [], failedChecks: [], phase: null },
    };
  }

  let validation = validateReportOutput('', { minChars, mode, findings });
  const semanticLimit = Math.max(1, Number(maxAttempts) || 1);
  const parseLimit = Math.max(2, semanticLimit);
  const providerLimit = semanticLimit;
  const attemptCounts = {
    provider: 0,
    parse: 0,
    semanticContract: 0,
    render: 0,
  };
  let providerCalls = 0;
  let consecutiveEmptyResponses = 0;
  let lastPhase;
  const promptArgs = {
    query, findings, limitations, strategy, passages, maxPassageChars, gaps, brief, contract,
  };

  const fail = (phase) => {
    throw new ReportGenerationError({
      attempts: providerCalls,
      minChars,
      outputChars: validation.outputChars,
      diagnostic: llm.getLastCallMetadata?.() || null,
      flags: validation.flags,
      failedChecks: validation.failedChecks,
      phase,
      contract,
      attemptCounts,
    });
  };

  while (true) {
    signal?.throwIfAborted?.();
    const attempt = providerCalls + 1;
    onAttempt({
      status: 'started',
      attempt,
      maxAttempts: semanticLimit,
      phase: null,
      attemptCounts: { ...attemptCounts },
    });
    const startedAt = Date.now();
    const report = await llm.complete({
      messages: retryContext
        ? reportRevisionRetryPrompt({ ...promptArgs, ...retryContext })
        : (attempt === 1 ? reportPrompt(promptArgs) : reportRetryPrompt(promptArgs)),
      signal,
      temperature: attempt === 1 ? 0.2 : 0,
      purpose,
      attempt,
      ...(maxTokens > 0 ? { maxTokens } : { maxTokens: 0 }),
    });
    const raw = String(report || '');
    providerCalls += 1;
    const cleaned = sanitizeNarrativeResponse(raw);
    const diagnostic = llm.getLastCallMetadata?.() || null;

    if (!cleaned) {
      consecutiveEmptyResponses += 1;
      attemptCounts.provider += 1;
      lastPhase = 'provider';
      validation = validateReportOutput('', { minChars, mode, findings });
      onAttempt({
        status: 'invalid',
        attempt,
        maxAttempts: providerLimit,
        durationMs: Date.now() - startedAt,
        outputChars: 0,
        flags: validation.flags,
        failedChecks: validation.failedChecks,
        diagnostic,
        phase: lastPhase,
        attemptCounts: { ...attemptCounts },
      });
      if (consecutiveEmptyResponses >= providerLimit) fail(lastPhase);
      continue;
    }

    consecutiveEmptyResponses = 0;
    const structured = looksLikeStructuredNarrative(cleaned);
    const parsed = parseNarrativeResponse(cleaned, {
      requireCitedKeyFindings: false,
    });

    if (structured && parsed.flags?.includes('narrative_not_json')) {
      attemptCounts.parse += 1;
      lastPhase = 'parse';
      validation = {
        ok: false,
        text: cleaned,
        outputChars: cleaned.length,
        flags: ['narrative_not_json'],
        failedChecks: [{
          check: 'narrative_not_json',
          expected: { validStructuredNarrative: true },
          actual: { validStructuredNarrative: false, characters: cleaned.length },
        }],
      };
      onAttempt({
        status: 'invalid',
        attempt,
        maxAttempts: parseLimit,
        durationMs: Date.now() - startedAt,
        outputChars: validation.outputChars,
        flags: validation.flags,
        failedChecks: validation.failedChecks,
        diagnostic,
        phase: lastPhase,
        attemptCounts: { ...attemptCounts },
      });
      if (attemptCounts.parse >= parseLimit) fail(lastPhase);
      continue;
    }

    const document = parsed.narrative || parseMarkdownNarrative(cleaned);
    const origin = parsed.narrative ? 'json' : 'markdown';
    const rendered = renderNarrativeMarkdown(document);
    const renderedValidation = validateReportOutput(rendered, { minChars, mode, findings });
    const rawValidation = structured
      ? renderedValidation
      : validateReportOutput(cleaned, { minChars, mode, findings });
    const failedChecks = mergeValidationChecks(rawValidation, renderedValidation);
    validation = withParserFlags({
      ...renderedValidation,
      ok: failedChecks.length === 0,
      flags: failedChecks.map((item) => item.check),
      failedChecks,
    }, structured ? parsed.flags : []);
    lastPhase = validation.ok ? null : classifyReportFailurePhase(validation);
    if (!validation.ok) {
      if (lastPhase === 'render') attemptCounts.render += 1;
      else attemptCounts.semanticContract += 1;
    }

    onAttempt({
      status: validation.ok ? 'completed' : 'invalid',
      attempt,
      maxAttempts: lastPhase === 'semantic-contract' ? semanticLimit : 1,
      durationMs: Date.now() - startedAt,
      outputChars: validation.outputChars,
      flags: validation.flags,
      failedChecks: validation.failedChecks,
      diagnostic,
      phase: lastPhase,
      attemptCounts: { ...attemptCounts },
    });
    if (validation.ok) {
      return {
        text: validation.text,
        document,
        origin,
        diagnostics: {
          flags: validation.flags,
          failedChecks: validation.failedChecks,
          phase: null,
          attemptCounts,
          providerCalls,
        },
      };
    }
    if (lastPhase === 'render') fail(lastPhase);
    if (attemptCounts.semanticContract >= semanticLimit) fail(lastPhase);
  }
}
