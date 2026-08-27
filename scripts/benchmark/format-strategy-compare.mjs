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

function formatPass(value) {
  return value ? 'pass' : 'fail';
}

function slotSummary(audit) {
  const slots = audit?.requiredSlotCompletion?.slots || [];
  const completed = slots.filter((slot) => slot.status === 'completed').length;
  return slots.length ? `${completed}/${slots.length}` : 'n/a';
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

  if (comparison.runs.some((run) => run.audit)) {
    lines.push(
      '',
      '## Strategy Audit',
      '',
      'Official result is `ready` / `not_ready` / `invalid`. This is a deterministic evidence contract, not a quality or truth grade. `--no-llm` is the official compare path.',
      '',
      '| Strategy | Status | Process | Report | Citations | Provenance | Required slots |',
      '| --- | --- | --- | --- | --- | --- | ---: |',
    );
    for (const run of comparison.runs) {
      const audit = run.audit;
      if (!audit) continue;
      lines.push(
        `| ${run.strategyLabel} | ${audit.status} | ${formatPass(audit.processContract.pass)} | ${formatPass(audit.reportIntegrity.pass)} | ${formatPass(audit.citationIntegrity.pass)} | ${formatPass(audit.evidenceProvenance.pass)} | ${slotSummary(audit)} |`,
      );
    }

    for (const run of comparison.runs) {
      const slots = run.audit?.requiredSlotCompletion?.slots || [];
      if (!slots.length) continue;
      lines.push('', `### ${run.strategyLabel} slots`);
      for (const slot of slots) {
        const failed = slot.checks.filter((item) => !item.pass).map((item) => item.id);
        lines.push(`- \`${slot.id}\`: ${slot.status}${failed.length ? ` (${failed.join(', ')})` : ''}`);
      }
    }

    for (const run of comparison.runs) {
      const failed = (run.audit?.processContract?.checks || []).filter((item) => !item.pass);
      if (!failed.length) continue;
      lines.push('', `### ${run.strategyLabel} process gaps`);
      for (const item of failed) {
        lines.push(`- ${item.id}: ${item.detail}`);
      }
    }
  }

  if (comparison.deltas?.length) {
    const baseline = comparison.runs[0]?.strategyLabel || 'baseline';
    lines.push('', `## Official deltas vs ${baseline}`, '');
    for (const delta of comparison.deltas) {
      lines.push(`### ${delta.strategyLabel}`);
      lines.push(`- Duration: ${formatDelta(delta.durationMs, { suffix: 'ms' })} (${formatDurationMs(delta.durationMs)})`);
      lines.push(`- LLM tokens: ${formatDelta(delta.llmTokens)}`);
      lines.push(`- Search requests: ${formatDelta(delta.searchRequests)}`);
      lines.push(`- Source reads: ${formatDelta(delta.sourceReads)}`);
      lines.push(`- Rerank requests: ${formatDelta(delta.rerankRequests)}`);
      lines.push(`- Completed slots: ${formatDelta(delta.completedSlots)}`);
      lines.push(`- Resolved citations: ${formatDelta(delta.resolvedCitations)}`);
      lines.push(`- Real bodies: ${formatDelta(delta.realBodies)}`);
      lines.push(`- Process contract: ${formatDelta(delta.processContractPass)}`);
      lines.push(`- Status: ${delta.status || 'n/a'} (baseline ${delta.baselineStatus || 'n/a'})`);
      lines.push(`- Sources: ${formatDelta(delta.sourceCount)}`);
      lines.push('');
    }
  }

  lines.push(
    '',
    '## Optional semantic analysis (non-official)',
    '',
    'Stored or runtime claim verdicts and overlap rates are **not** part of the official contract. They must not be read as `ready` / `not_ready`.',
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

  lines.push('', '## Session Paths', '');
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

  return `${lines.join('\n')}\n`;
}

export function formatStrategyCompareJson(comparison) {
  return JSON.stringify(comparison, null, 2);
}
