import { formatDurationMs } from './extract-run-stats.mjs';

function formatValue(value) {
  return value === null || value === undefined ? 'n/a' : value;
}

function formatCost(run, field) {
  const value = run.cost[field];
  if (!Number.isFinite(value)) return 'n/a';
  const unknown = run.cost.unknownUsage?.[field]
    || (field === 'llmTokens' && run.cost.costIsLowerBound);
  return unknown ? `>= ${value} (total unknown)` : value;
}

function formatDelta(value, { percent = false, suffix = '' } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  if (percent) return `${sign}${Math.round(value * 100)}pp`;
  return `${sign}${value}${suffix}`;
}

function formatPass(value) {
  return typeof value === 'boolean' ? (value ? 'pass' : 'fail') : 'n/a';
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
  const counts = audit?.slotCounts || audit?.requiredSlotCompletion?.counts;
  if (counts?.total || counts?.required) {
    return `required ${counts.requiredCompleted || 0}/${counts.required || 0}; all ${counts.completed || 0}/${counts.total || 0}`;
  }
  const fallback = slotStatusCounts(audit);
  return fallback.total ? `${fallback.completed}/${fallback.total}` : 'n/a';
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
    '| Strategy | Duration | Sources | LLM tokens | LLM reqs | source_summary | Search | Reads | Rerank | Stored runtime gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );

  for (const run of comparison.runs) {
    lines.push(
      `| ${run.strategyLabel} | ${run.durationLabel} | ${formatValue(run.counts.sourceCount)} | ${formatCost(run, 'llmTokens')} | ${formatCost(run, 'llmRequests')} | ${run.llmPurposes?.sourceSummaryCalls ?? 'n/a'} | ${formatCost(run, 'searchRequests')} | ${formatCost(run, 'sourceReads')} | ${formatCost(run, 'rerankRequests')} | ${run.gate || 'n/a'} |`,
    );
  }

  if (comparison.runs.some((run) => run.audit)) {
    lines.push(
      '',
      '## Legacy heuristic diagnostics',
      '',
      'The historical `ready` / `not_ready` / `invalid` labels describe runtime diagnostics. Slot checks include query-specific keyword, host, and number heuristics; they do not establish independent answer completeness, semantic correctness, or program acceptance.',
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
      if (audit.status === 'invalid' && audit.invalidReasons?.length) {
        lines.push('', `- ${run.strategyLabel} invalid because: ${audit.invalidReasons.join(', ')}`);
      }
    }

    lines.push(
      '',
      '### Observable counts',
      '',
      'Counts below are observations from the legacy diagnostics and declared runtime state. A completed slot here is a historical heuristic result, not a new independent quality judgment.',
      '',
      '| Strategy | Completed | Blocked | Missing | Empty bullets | Real bodies | WAF rejected | Resolved citations |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const run of comparison.runs) {
      const audit = run.audit;
      if (!audit) continue;
      const slots = slotStatusCounts(audit);
      lines.push(
        `| ${run.strategyLabel} | ${slots.completed} | ${slots.blocked} | ${slots.missing} | ${audit.reportIntegrity?.counts?.emptyBulletCount ?? 'n/a'} | ${audit.evidenceProvenance?.counts?.realBodies ?? 'n/a'} | ${audit.evidenceProvenance?.counts?.wafRejected ?? 'n/a'} | ${audit.citationIntegrity?.counts?.resolved ?? 'n/a'} |`,
      );
    }

    lines.push(
      '',
      '### Descriptive observability',
      '',
      'These fields describe the recorded search, assessment, and cache behavior.',
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
    lines.push('', `## Recorded cost and diagnostic deltas vs ${baseline}`, '');
    for (const delta of comparison.deltas) {
      lines.push(`### ${delta.strategyLabel}`);
      lines.push(`- Duration: ${formatDelta(delta.durationMs, { suffix: 'ms' })} (${formatDurationMs(delta.durationMs)})`);
      lines.push(`- LLM tokens: ${formatDelta(delta.llmTokens)}`);
      lines.push(`- Search requests: ${formatDelta(delta.searchRequests)}`);
      lines.push(`- Source reads: ${formatDelta(delta.sourceReads)}`);
      lines.push(`- Rerank requests: ${formatDelta(delta.rerankRequests)}`);
      lines.push(`- Legacy heuristic completed slots: ${formatDelta(delta.completedSlots)}`);
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
    '## Artifact verification and model observation',
    '',
    'Artifact verification checks the pinned files, declared references, and evidence ranges. Independent model assessment was not run. Stored claim verdicts and keyword overlap are not imported as quality scores; unobserved values remain n/a.',
    '',
    '| Strategy | Artifact verification | Model observed | Model thresholds met |',
    '| --- | --- | --- | --- |',
  );

  for (const run of comparison.runs) {
    const { artifactVerification, modelAssessment } = run.benchmark;
    lines.push(
      `| ${run.strategyLabel} | ${artifactVerification?.status ?? 'incomplete'} | ${modelAssessment?.observed === true ? 'yes' : 'no'} | ${formatValue(modelAssessment?.modelThresholdsMet)} |`,
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
      lines.push(`  - actual tokens: ${formatCost(run, 'llmTokens')}`);
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
