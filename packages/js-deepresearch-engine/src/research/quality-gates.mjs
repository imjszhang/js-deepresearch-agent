import { normalizeSourceUrl } from './source-candidates.mjs';

function sourceKey(source) { return normalizeSourceUrl(source?.url) || `${source?.title || ''}:${source?.snippet || ''}`; }

export function evaluateEvidenceSufficiency({ findings = [], iteration = 1, minIterations = 1, query = '' }) {
  const successful = findings.filter((finding) => !finding.error && (finding.sources || []).length > 0);
  const sources = successful.flatMap((finding) => finding.sources || []);
  const unique = new Set(sources.map(sourceKey).filter(Boolean));
  const hosts = new Set(sources.map((source) => {
    try { return new URL(source.url).hostname; } catch { return ''; }
  }).filter(Boolean));
  const flags = [];
  if (successful.length === 0) flags.push('no_successful_findings');
  if (unique.size === 0) flags.push('empty_sources');
  if (unique.size > 1 && hosts.size === 1) flags.push('single_host_concentration');
  if (sources.length > 0 && sources.every((source) => !source.content && !source.summary)) flags.push('snippet_only_evidence');
  const freshnessRequired = /\b(latest|current|today|recent|newest|目前|当前|最新|最近)\b/i.test(query);
  if (freshnessRequired && !sources.some((source) => source.publishedAt || source.date || source.updatedAt)) flags.push('freshness_unknown');
  const comparisonRequired = /\b(compare|versus|\bvs\.?\b|comparison|对比|比较)\b/i.test(query);
  if (comparisonRequired && successful.length < 2) flags.push('comparison_coverage_incomplete');
  const criticalGaps = successful.length === 0 ? ['No research question has usable sources.'] : [];
  const sufficient = iteration >= minIterations && successful.length > 0
    && unique.size >= Math.min(2, successful.length)
    && !flags.includes('freshness_unknown')
    && !flags.includes('comparison_coverage_incomplete');
  return {
    decision: sufficient ? 'stop' : (criticalGaps.length ? 'continue_with_focus' : 'continue'),
    confidence: sufficient ? 0.8 : 0.45,
    criticalGaps,
    recommendedQuestions: criticalGaps,
    flags,
    method: 'rules',
  };
}

export function evaluatePreReport({ findings = [], gaps = [] }) {
  const flags = [];
  const sourceCount = findings.flatMap((finding) => finding.sources || []).length;
  const findingsWithSources = findings.filter((finding) => (finding.sources || []).length > 0).length;
  if (sourceCount === 0) flags.push('empty_sources');
  if (findings.length > 0 && findingsWithSources === 0) flags.push('no_finding_sources');
  const criticalGaps = gaps.filter((gap) => gap.priority === 'critical' && gap.status !== 'resolved').map((gap) => gap.question);
  if (criticalGaps.length) flags.push('critical_gaps_open');
  const limitations = [...criticalGaps];
  if (flags.includes('empty_sources')) limitations.push('No usable external sources were found.');
  if (flags.includes('no_finding_sources')) limitations.push('Research findings are not backed by source records.');
  return {
    gate: flags.length === 0 ? 'pass' : (sourceCount > 0 ? 'pass_with_warnings' : 'fail'),
    flags,
    criticalGaps,
    limitations,
    metrics: { findingCount: findings.length, findingsWithSources, sourceCount },
  };
}
