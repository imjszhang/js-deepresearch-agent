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

function formatList(values) {
  if (!Array.isArray(values) || values.length === 0) return 'n/a';
  return values.join(', ');
}

function formatOutcomes(outcomes) {
  if (!outcomes || typeof outcomes !== 'object' || !Object.keys(outcomes).length) return 'n/a';
  return Object.entries(outcomes).map(([key, count]) => `${key}:${count}`).join(', ');
}

function formatAssessment(assessment) {
  if (!assessment) return 'n/a';
  const readability = assessment.readability
    ? Object.entries(assessment.readability).map(([key, count]) => `${key}:${count}`).join(', ')
    : '';
  return assessment.count != null ? `${assessment.count}${readability ? ` (${readability})` : ''}` : 'n/a';
}

function formatCache(cache) {
  if (!cache) return 'n/a';
  return `hits ${cache.hits ?? 0} / misses ${cache.misses ?? 0}`;
}

function slotSummary(audit) {
  const counts = slotStatusCounts(audit);
  return counts.total ? `${counts.completed}/${counts.total}` : 'n/a';
}

function slotStatusCounts(audit) {
  const slots = audit?.requiredSlotCompletion?.slots || [];
  return {
    total: slots.length,
    completed: slots.filter((slot) => slot.status === 'completed').length,
    blocked: slots.filter((slot) => slot.status === 'blocked').length,
    missing: slots.filter((slot) => slot.status === 'missing').length,
  };
}

function collectSlotIds(runs = []) {
  const ids = [];
  for (const run of runs) {
    for (const slot of run.audit?.requiredSlotCompletion?.slots || []) {
      if (!ids.includes(slot.id)) ids.push(slot.id);
    }
  }
  return ids;
}

function slotById(audit, slotId) {
  return (audit?.requiredSlotCompletion?.slots || []).find((slot) => slot.id === slotId) || null;
}

function formatSlotStatus(slot) {
  if (!slot) return 'n/a';
  if (slot.status === 'completed') return 'completed';
  const failed = (slot.checks || []).filter((item) => !item.pass).map((item) => item.id);
  return failed.length ? `${slot.status} (${failed.join(', ')})` : slot.status;
}

function slotStatusesDiffer(runs, slotId) {
  const statuses = runs
    .map((run) => slotById(run.audit, slotId)?.status || 'n/a')
    .join('\0');
  return new Set(statuses.split('\0')).size > 1;
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

    lines.push(
      '',
      '### Observable counts',
      '',
      'These are the comparable numbers. `status` stays `not_ready` until every hard gate passes; it is not the ranking.',
      '',
      '| Strategy | Completed | Blocked | Missing | Empty bullets | Real bodies | WAF rejected | Resolved citations |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const run of comparison.runs) {
      const audit = run.audit;
      if (!audit) continue;
      const slots = slotStatusCounts(audit);
      lines.push(
        `| ${run.strategyLabel} | ${slots.completed} | ${slots.blocked} | ${slots.missing} | ${audit.reportIntegrity?.counts?.emptyBulletCount ?? 0} | ${audit.evidenceProvenance?.counts?.realBodies ?? 0} | ${audit.evidenceProvenance?.counts?.wafRejected ?? 0} | ${audit.citationIntegrity?.counts?.resolved ?? 0} |`,
      );
    }

    lines.push(
      '',
      '### Descriptive observability',
      '',
      'These fields explain search, assessment, and cache behavior. They are not official audit gates and do not change `status`.',
      '',
      '| Strategy | Query outcomes | Responded engines | Unresponsive engines | Assessment | Slot-support cache | Agent snapshot |',
      '| --- | --- | --- | --- | --- | --- | ---: |',
    );
    for (const run of comparison.runs) {
      const obs = run.observability || {};
      lines.push(
        `| ${run.strategyLabel} | ${formatOutcomes(obs.queryOutcomes)} | ${formatList(obs.respondedEngines)} | ${formatList(obs.unresponsiveEngines)} | ${formatAssessment(obs.sourceAssessment)} | ${formatCache(obs.slotSupportCache)} | ${obs.agentSnapshotChars ?? 'n/a'} |`,
      );
    }

    const slotIds = collectSlotIds(comparison.runs);
    if (slotIds.length && comparison.runs.length > 1) {
      const labels = comparison.runs.map((run) => run.strategyLabel);
      lines.push(
        '',
        '### Slot matrix',
        '',
        `| Slot | ${labels.join(' | ')} |`,
        `| --- | ${labels.map(() => '---').join(' | ')} |`,
      );
      for (const slotId of slotIds) {
        const cells = comparison.runs.map((run) => formatSlotStatus(slotById(run.audit, slotId)));
        lines.push(`| \`${slotId}\` | ${cells.join(' | ')} |`);
      }

      const diverged = slotIds.filter((slotId) => slotStatusesDiffer(comparison.runs, slotId));
      lines.push('', '### Where strategies differ');
      if (diverged.length === 0) {
        lines.push('', 'No slot status differs across the compared runs.');
      } else {
        lines.push('');
        for (const slotId of diverged) {
          const parts = comparison.runs.map((run) => `${run.strategyLabel}=${formatSlotStatus(slotById(run.audit, slotId))}`);
          lines.push(`- \`${slotId}\`: ${parts.join('; ')}`);
        }
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
