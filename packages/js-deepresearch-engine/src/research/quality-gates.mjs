import { isPrimarySource, normalizeSourceUrl } from './source-candidates.mjs';

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
  const freshnessRequired = /\b(latest|current|today|recent|newest|as of)\b|目前|当前|最新|最近|截至|20\d{2}年/i.test(query);
  if (freshnessRequired && !sources.some((source) => source.publishedAt || source.date || source.updatedAt)) flags.push('freshness_unknown');
  const comparisonRequired = /\b(compare|versus|\bvs\.?\b|comparison|对比|比较)\b/i.test(query);
  if (comparisonRequired && successful.length < 2) flags.push('comparison_coverage_incomplete');
  const primaryRequired = /\b(open[ -]?source|software|project|framework|architecture|implementation|standard|scientific|research)\b|开源|软件|项目|框架|架构|实现|标准|论文|研究/i.test(query);
  if (primaryRequired && !sources.some(isPrimarySource)) flags.push('primary_source_missing');
  const criticalGaps = [];
  if (successful.length === 0) criticalGaps.push('No research question has usable sources.');
  if (flags.includes('primary_source_missing')) criticalGaps.push('Primary or official evidence is missing.');
  const recommendedQuestions = [];
  if (flags.includes('primary_source_missing')) recommendedQuestions.push(`site:github.com ${query}`);
  if (flags.includes('freshness_unknown')) recommendedQuestions.push(`${query} official sources publication date current status`);
  const sufficient = iteration >= minIterations && successful.length > 0
    && unique.size >= Math.min(2, successful.length)
    && !flags.includes('freshness_unknown')
    && !flags.includes('comparison_coverage_incomplete')
    && !flags.includes('primary_source_missing');
  return {
    decision: sufficient ? 'stop' : (criticalGaps.length ? 'continue_with_focus' : 'continue'),
    confidence: sufficient ? 0.8 : 0.45,
    criticalGaps,
    recommendedQuestions,
    flags,
    method: 'rules',
  };
}

export function evaluatePreReport({ findings = [], gaps = [], query = '' }) {
  const flags = [];
  const sources = findings.flatMap((finding) => finding.sources || []);
  const sourceCount = sources.length;
  const findingsWithSources = findings.filter((finding) => (finding.sources || []).length > 0).length;
  const directEvidenceSources = sources.filter((source) => source.fetchStatus === 'ok' && source.content).length;
  if (sourceCount === 0) flags.push('empty_sources');
  if (findings.length > 0 && findingsWithSources === 0) flags.push('no_finding_sources');
  if (sourceCount > 0 && directEvidenceSources === 0) flags.push('no_direct_evidence');
  const primaryRequired = /\b(open[ -]?source|software|project|framework|architecture|implementation|standard|scientific|research)\b|开源|软件|项目|框架|架构|实现|标准|论文|研究/i.test(query);
  if (primaryRequired && !sources.some(isPrimarySource)) flags.push('primary_source_missing');
  const criticalGaps = gaps.filter((gap) => gap.priority === 'critical' && !['resolved', 'verified'].includes(gap.status)).map((gap) => gap.question);
  const openGaps = gaps.filter((gap) => !['resolved', 'verified'].includes(gap.status));
  if (criticalGaps.length) flags.push('critical_gaps_open');
  if (openGaps.length) flags.push('open_gaps');
  const limitations = [...criticalGaps];
  if (openGaps.length) limitations.push(`${openGaps.length} research gap${openGaps.length === 1 ? '' : 's'} remain unresolved.`);
  if (flags.includes('empty_sources')) limitations.push('No usable external sources were found.');
  if (flags.includes('no_finding_sources')) limitations.push('Research findings are not backed by source records.');
  if (flags.includes('no_direct_evidence')) limitations.push('Available evidence is limited to search snippets; no source body was successfully read.');
  if (flags.includes('primary_source_missing')) limitations.push('No primary or official source was available to verify implementation-level claims.');
  return {
    gate: flags.length === 0 ? 'pass' : (sourceCount > 0 ? 'pass_with_warnings' : 'fail'),
    flags,
    criticalGaps,
    limitations,
    metrics: { findingCount: findings.length, findingsWithSources, sourceCount, directEvidenceSources, openGapCount: openGaps.length },
  };
}
