import { reportPrompt, reportRetryPrompt, reportRevisionRetryPrompt } from './prompts.mjs';
import { parseCitations, parseInternalReferenceTokens } from './citations.mjs';
import { classifyClaimSection } from './claim-quality.mjs';
import { containsSourceDump } from './report-narrative.mjs';
import { parseMarkdownNarrative, parseNarrativeResponse } from './report-narrative.mjs';

const LABELED_NARRATIVE_HEADING = /^(summary|executive summary|key findings|findings|confirmed background facts|background facts|摘要|总结|概述|关键发现|核心发现|主要发现|已确认背景事实|背景事实)\b/i;

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
    phase = null,
    contract = null,
  }) {
    const reasoningHint = diagnostic?.hasReasoningContent && !diagnostic?.hasContent
      ? ' The provider returned reasoning metadata but no final content.'
      : '';
    const phaseHint = phase ? ` [${phase}]` : '';
    super(`Report generation produced no usable report after ${attempts} attempts (minimum ${minChars} characters; received ${outputChars}).${phaseHint}${reasoningHint}`);
    this.name = 'ReportGenerationError';
    this.code = 'REPORT_OUTPUT_INVALID';
    this.attempts = attempts;
    this.minChars = minChars;
    this.outputChars = outputChars;
    this.diagnostic = diagnostic;
    this.flags = flags;
    this.phase = phase;
    this.contract = contract;
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

export function isPlaceholderSummary(text = '') {
  const stripped = String(text)
    .replace(/[#*_`[\]()>]/g, '')
    .replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '');
  return stripped.length < 12;
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
  const flags = [];
  if (!text) flags.push('empty_report');
  else if (mode !== 'full' && text.length < minChars) flags.push('report_too_short');
  if (text && !/^#{1,6}\s+\S+/m.test(text)) flags.push('report_missing_heading');
  if (text && mode === 'narrative' && looksTruncated(text)) flags.push('report_truncated');
  const narrativeText = mode === 'full' ? textBeforeGeneratedSections(text) : text;
  const labeled = extractLabeledNarrativeText(narrativeText);
  if (text && labeled.length < minChars) flags.push('report_short_narrative');
  if (text && containsSourceDump(narrativeText)) flags.push('report_contains_source_dump');
  if (text && isPlaceholderSummary(summarySectionBody(narrativeText))) {
    flags.push('report_empty_summary');
  }
  if (mode === 'full') {
    if (!hasSectionKind(text, REQUIRED_FULL_GROUPS.narrative)) flags.push('report_missing_summary_or_findings');
    if (!/^#{1,6}\s+(Evidence|证据)\b/im.test(text)) flags.push('report_missing_evidence');
    if (!hasSectionKind(text, ['source_entry'])) flags.push('report_missing_sources');
    if (!hasSectionKind(text, ['caveat'])) flags.push('report_missing_caveats');
  }
  const dangling = unresolvedCitations(text, findings);
  if (dangling.length) flags.push('report_unresolved_citations');
  if (parseInternalReferenceTokens(text).length) flags.push('report_internal_reference_token');
  if (hasEmptyBulletLines(text)) flags.push('report_empty_bullets');
  return { ok: flags.length === 0, text, outputChars: text.length, flags };
}

export function emptyBulletLines(report = '') {
  return String(report || '').split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s*$/.test(line));
}

function hasEmptyBulletLines(report = '') {
  return emptyBulletLines(report).length > 0;
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
      diagnostics: { flags: [] },
    };
  }

  let validation = { outputChars: 0, flags: ['empty_report'] };
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  const promptArgs = {
    query, findings, limitations, strategy, passages, maxPassageChars, gaps, brief, contract,
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted?.();
    onAttempt({ status: 'started', attempt, maxAttempts: attempts, phase: 'provider' });
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
    const parsed = parseNarrativeResponse(raw, {
      requireCitedKeyFindings: false,
    });
    const document = parsed.narrative || parseMarkdownNarrative(raw);
    const origin = parsed.narrative ? 'json' : 'markdown';
    const candidate = parsed.ok && parsed.markdown ? parsed.markdown : raw;
    validation = validateReportOutput(candidate, { minChars, mode, findings });
    if (parsed.flags?.includes('narrative_has_generated_sections')) {
      validation = {
        ...validation,
        ok: false,
        flags: [...new Set([...(validation.flags || []), ...parsed.flags])],
      };
    }
    const diagnostic = llm.getLastCallMetadata?.() || null;
    onAttempt({
      status: validation.ok ? 'completed' : 'invalid',
      attempt,
      maxAttempts: attempts,
      durationMs: Date.now() - startedAt,
      outputChars: validation.outputChars,
      flags: validation.flags,
      diagnostic,
      phase: 'provider',
    });
    if (validation.ok) {
      return {
        text: validation.text,
        document,
        origin,
        diagnostics: { flags: validation.flags },
      };
    }
  }
  throw new ReportGenerationError({
    attempts,
    minChars,
    outputChars: validation.outputChars,
    diagnostic: llm.getLastCallMetadata?.() || null,
    flags: validation.flags,
    phase: 'provider',
    contract,
  });
}
