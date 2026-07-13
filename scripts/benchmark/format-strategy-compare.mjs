import { formatDurationMs } from './extract-run-stats.mjs';

function formatPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatDelta(value, { percent = false, suffix = '' } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  if (percent) return `${sign}${Math.round(value * 100)}pp`;
  return `${sign}${value}${suffix}`;
}

export function formatStrategyCompareMarkdown(comparison) {
  const lines = [
    '# Strategy Benchmark Comparison',
    '',
    `- Query: ${comparison.query || '(mixed queries)'}`,
    `- Compared at: ${comparison.comparedAt}`,
    '',
  ];

  if (comparison.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of comparison.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  lines.push(
    '## Overview',
    '',
    '| Strategy | Duration | Sources | LLM tokens | LLM reqs | source_summary | Search | Reads | Rerank | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );

  for (const run of comparison.runs) {
    lines.push(
      `| ${run.strategyLabel} | ${run.durationLabel} | ${run.counts.sourceCount} | ${run.cost.llmTokens} | ${run.cost.llmRequests} | ${run.llmPurposes?.sourceSummaryCalls ?? 'n/a'} | ${run.cost.searchRequests} | ${run.cost.sourceReads} | ${run.cost.rerankRequests} | ${run.gate || 'n/a'} |`,
    );
  }

  lines.push(
    '',
    '## Quality Metrics',
    '',
    '| Strategy | Supported | Partial | Unsupported | Unverifiable | Evidence cov. | Direct ev. | Key claim sup. |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const run of comparison.runs) {
    const { metrics } = run.benchmark;
    lines.push(
      `| ${run.strategyLabel} | ${formatPercent(metrics.rates.supportedRate)} | ${formatPercent(metrics.rates.partiallySupportedRate)} | ${formatPercent(metrics.rates.unsupportedRate)} | ${formatPercent(metrics.rates.unverifiableRate)} | ${formatPercent(metrics.rates.evidenceCoverageRate)} | ${formatPercent(metrics.rates.directEvidenceRate)} | ${formatPercent(metrics.rates.keyClaimSupportedRate)} |`,
    );
  }

  if (comparison.deltas?.length) {
    const baseline = comparison.runs[0]?.strategyLabel || 'baseline';
    lines.push('', `## Deltas vs ${baseline}`, '');
    for (const delta of comparison.deltas) {
      lines.push(`### ${delta.strategyLabel}`);
      lines.push(`- Duration: ${formatDelta(delta.durationMs, { suffix: 'ms' })} (${formatDurationMs(delta.durationMs)})`);
      lines.push(`- LLM tokens: ${formatDelta(delta.llmTokens)}`);
      lines.push(`- Search requests: ${formatDelta(delta.searchRequests)}`);
      lines.push(`- Source reads: ${formatDelta(delta.sourceReads)}`);
      lines.push(`- Rerank requests: ${formatDelta(delta.rerankRequests)}`);
      lines.push(`- Supported rate: ${formatDelta(delta.supportedRate, { percent: true })}`);
      lines.push(`- Evidence coverage: ${formatDelta(delta.evidenceCoverageRate, { percent: true })}`);
      lines.push(`- Sources: ${formatDelta(delta.sourceCount)}`);
      lines.push('');
    }
  }

  lines.push('## Session Paths', '');
  for (const run of comparison.runs) {
    lines.push(`- **${run.strategyLabel}**: ${run.workDir || run.researchId || '(unknown)'}`);
    if (run.qualityFlags.length > 0) {
      lines.push(`  - flags: ${run.qualityFlags.join(', ')}`);
    }
    if (run.stopReason) {
      lines.push(`  - stop reason: ${run.stopReason}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatStrategyCompareJson(comparison) {
  return JSON.stringify(comparison, null, 2);
}
