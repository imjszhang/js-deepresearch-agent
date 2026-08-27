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
    '| Strategy | Supported | At least partial | Partial | Unsupported | Unverifiable | Evidence cov. | Direct ev. | Key claim sup. |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const run of comparison.runs) {
    const { metrics } = run.benchmark;
    lines.push(
      `| ${run.strategyLabel} | ${formatPercent(metrics.rates.supportedRate)} | ${formatPercent(metrics.rates.supportedOrPartialRate)} | ${formatPercent(metrics.rates.partiallySupportedRate)} | ${formatPercent(metrics.rates.unsupportedRate)} | ${formatPercent(metrics.rates.unverifiableRate)} | ${formatPercent(metrics.rates.evidenceCoverageRate)} | ${formatPercent(metrics.rates.directEvidenceRate)} | ${formatPercent(metrics.rates.keyClaimSupportedRate)} |`,
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
      lines.push(`- Narrative at least partial: ${formatDelta(delta.supportedOrPartialRate, { percent: true })}`);
      lines.push(`- Subject coverage: ${formatDelta(delta.subjectRate, { percent: true })}`);
      lines.push(`- Aspect coverage: ${formatDelta(delta.aspectRate, { percent: true })}`);
      lines.push(`- Subject × aspect cells: ${formatDelta(delta.cellRate, { percent: true })}`);
      lines.push(`- Bodies per subject: ${formatDelta(delta.subjectBodyRate, { percent: true })}`);
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
    if (run.minLlmTokens || run.targetLlmTokens) {
      lines.push(`  - min tokens: ${run.minLlmTokens || run.targetLlmTokens}`);
    }
    if (run.actualLlmTokens != null || run.cost?.llmTokens != null) {
      lines.push(`  - actual tokens: ${run.actualLlmTokens ?? run.cost.llmTokens}`);
    }
    if (run.unusedBudgetTokens != null) {
      lines.push(`  - unused budget: ${run.unusedBudgetTokens}`);
    }
  }

  if (comparison.runs.some((run) => run.effectiveness)) {
    lines.push(
      '',
      '## Strategy Effectiveness',
      '',
      'Coverage and contract scores are promise-aware: quick is a snippet scan, focused should read bodies, exploratory should cover every named subject and aspect.',
      '',
      '| Strategy | Subjects | Cells | Body/subject | Official | Key claims | Narrative supported | At least partial | Tokens / supported | Contract |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const run of comparison.runs) {
      const effect = run.effectiveness;
      if (!effect) continue;
      lines.push(
        `| ${run.strategyLabel} | ${formatPercent(effect.coverage.subjectRate)} | ${formatPercent(effect.coverage.cellRate)} | ${formatPercent(effect.evidence.subjectBodyRate)} | ${formatPercent(effect.evidence.officialSubjectRate ?? effect.evidence.officialRate)} | ${effect.narrative.keyClaimCount} | ${formatPercent(effect.narrative.supportedRate)} | ${formatPercent(effect.narrative.supportedOrPartialRate)} | ${effect.efficiency.tokensPerSupportedClaim ?? 'n/a'} | ${effect.contract.pass ? 'pass' : 'fail'} |`,
      );
    }

    for (const run of comparison.runs) {
      const failed = (run.effectiveness?.contract.checks || []).filter((check) => !check.pass);
      if (!failed.length) continue;
      lines.push('', `### ${run.strategyLabel} contract gaps`);
      for (const check of failed) {
        lines.push(`- ${check.id}: ${check.detail}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatStrategyCompareJson(comparison) {
  return JSON.stringify(comparison, null, 2);
}
