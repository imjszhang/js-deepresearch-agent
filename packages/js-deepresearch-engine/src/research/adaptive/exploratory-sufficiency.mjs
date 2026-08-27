import { evaluateEvidenceSufficiency } from '../quality-gates.mjs';
import { isSuccessfulBody } from './body-quality.mjs';
import { evaluateReadinessGate } from './readiness-gate.mjs';

const DEFINITIONAL = /^(what(?:['’]?s| is| are)|who(?:['’]?s| is| are)|define|definition of|explain|什么是|谁是|定义)\b/i;
const COMPARISON = /\b(compare|versus|vs\.?|comparison|对比|比较)\b/i;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'of', 'to', 'vs', 'versus',
  'compare', 'comparison', 'with', 'local', 'deployment',
  'what', 'who', 'how', 'why', 'when', 'where', 'is', 'are', 'does', 'do', 'can',
]);

export function normalizeQuestion(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function questionTokens(value) {
  return new Set(normalizeQuestion(value).split(' ').filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

export function similarQuestions(left, right, threshold = 0.7) {
  const a = questionTokens(left);
  const b = questionTokens(right);
  if (!a.size || !b.size) return normalizeQuestion(left) === normalizeQuestion(right) && Boolean(normalizeQuestion(left));
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 && intersection / union >= threshold;
}

function cleanSubject(value) {
  return String(value || '')
    .replace(/^(?:compare|对比|比较)\s+/i, '')
    .replace(/[?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSubjectList(value) {
  return String(value || '')
    .split(/\s*(?:,|、|\/)\s*/)
    .flatMap((part) => String(part || '').split(/\s+(?:and|与|和|以及)\s+/i))
    .map(cleanSubject)
    .filter((item) => item && !/^(?:and|or|the|与|和)$/i.test(item));
}

export function extractComparisonSubjects(query) {
  const text = String(query || '').trim();
  const compareAnd = text.match(/(?:compare|对比|比较)\s+(.+?)\s+(?:and|与|和|以及)\s+(.+?)(?:\s+(?:for|in|on|regarding|的)\b|[?!]|$)/i);
  if (compareAnd) return [...splitSubjectList(compareAnd[1]), ...splitSubjectList(compareAnd[2])];
  const versus = text.match(/(.+?)\s+(?:vs\.?|versus|compared to|compared with)\s+(.+?)(?:\s+(?:for|in|on|regarding)\b|[?!]|$)/i);
  if (versus) return [...splitSubjectList(versus[1]), ...splitSubjectList(versus[2])];
  return [];
}

export function classifyResearchQuery(query) {
  const text = String(query || '').trim();
  if (COMPARISON.test(text)) {
    return { kind: 'comparison', subjects: extractComparisonSubjects(text) };
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (DEFINITIONAL.test(text) && wordCount <= 14) {
    return { kind: 'definitional', subjects: [] };
  }
  return { kind: 'open', subjects: [] };
}

export function sourceHasBody(source) {
  return isSuccessfulBody(source);
}

export function findingsHaveBodyEvidence(findings = []) {
  return findings.some((finding) => (finding.sources || []).some(sourceHasBody));
}

export function bodyEvidenceText(findings = []) {
  return findings.flatMap((finding) => (finding.sources || []).filter(sourceHasBody).map((source) => (
    [source.title, source.summary, source.content, source.snippet].filter(Boolean).join(' ')
  ))).join('\n').toLowerCase();
}

export function subjectsMissingBodyEvidence(findings, subjects = []) {
  const text = bodyEvidenceText(findings);
  return subjects.filter((subject) => {
    const needle = String(subject || '').trim().toLowerCase();
    return needle && !text.includes(needle);
  });
}

export function isOrthogonalGap(gaps, question) {
  const text = String(question || '').trim();
  if (!text) return false;
  return !(gaps || []).some((gap) => similarQuestions(gap.question, text));
}

export function evaluateExploratorySufficiency({
  query,
  findings = [],
  gaps = [],
  state = null,
} = {}) {
  const resolvedFindings = findings.length ? findings : (state?.findings || []);
  const resolvedGaps = gaps.length ? gaps : (state?.gaps || []);
  const resolvedQuery = query || state?.query || '';
  const shape = classifyResearchQuery(resolvedQuery);
  const base = evaluateEvidenceSufficiency({
    findings: resolvedFindings,
    iteration: 1,
    minIterations: 1,
    query: resolvedQuery,
  });
  const flags = [...(base.flags || [])];
  const hasBody = findingsHaveBodyEvidence(resolvedFindings);
  if (!hasBody && !flags.includes('snippet_only_evidence') && resolvedFindings.length) {
    flags.push('snippet_only_evidence');
  }
  if (!hasBody && !flags.includes('no_direct_evidence')) flags.push('no_direct_evidence');

  const missingSubjects = shape.kind === 'comparison'
    ? subjectsMissingBodyEvidence(resolvedFindings, shape.subjects)
    : [];
  if (missingSubjects.length) {
    if (!flags.includes('comparison_coverage_incomplete')) flags.push('comparison_coverage_incomplete');
  } else if (shape.kind === 'comparison' && shape.subjects.length >= 2) {
    const idx = flags.indexOf('comparison_coverage_incomplete');
    if (idx >= 0) flags.splice(idx, 1);
  }

  const criticalOpen = resolvedGaps.filter((gap) => {
    const covered = state?.gapCovered?.(gap.id)
      || (gap.status === 'resolved')
      || resolvedFindings.some((finding) => finding.gapId === gap.id && (finding.sources || []).some(sourceHasBody));
    return gap.priority === 'critical' && !covered;
  });

  const bodySourceCount = new Set(
    resolvedFindings.flatMap((finding) => (finding.sources || [])
      .filter(sourceHasBody)
      .map((source) => source.url || source.id)
      .filter(Boolean)),
  ).size;

  const gate = evaluateReadinessGate({
    query: resolvedQuery,
    profile: state?.profile || null,
    gaps: resolvedGaps,
    findings: resolvedFindings,
    missingSubjects,
  });
  for (const flag of gate.flags || []) {
    if (!flags.includes(flag)) flags.push(flag);
  }

  // Deterministic readiness is the only path to evidence_sufficient.
  const sufficient = Boolean(gate.pass);
  const inconclusive = !sufficient && hasBody && !flags.includes('primary_source_missing');

  return {
    ...base,
    flags,
    queryKind: shape.kind,
    subjects: shape.subjects,
    missingSubjects,
    hasBodyEvidence: hasBody,
    bodySourceCount,
    criticalOpenCount: criticalOpen.length,
    sufficient,
    inconclusive,
    readiness: gate,
    decision: gate.decision === 'stop' ? 'stop' : (criticalOpen.length || missingSubjects.length || gate.openRequired ? 'continue_with_focus' : 'continue'),
    method: 'rules',
  };
}
