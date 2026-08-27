import { loadArtifacts, loadArtifactsByResearchId } from './load-artifacts.mjs';
import { runBenchmark } from './run-benchmark.mjs';
import { extractRunStats } from './extract-run-stats.mjs';
import { auditStrategyRun } from './strategy-effectiveness.mjs';

function collectWarnings(runs) {
  const warnings = [];
  const queries = [...new Set(runs.map((run) => run.query).filter(Boolean))];
  const metricVersions = [...new Set(runs.map((run) => run.benchmark.metrics.metricsVersion))];
  const labels = runs.map((run) => run.strategyLabel);
  const duplicateLabels = labels.filter((label, index) => labels.indexOf(label) !== index);

  if (queries.length > 1) warnings.push('Compared runs use different queries.');
  if (metricVersions.length > 1) warnings.push('Compared runs use different quality metrics versions.');
  if (duplicateLabels.length > 0) {
    warnings.push(`Duplicate strategy labels detected: ${[...new Set(duplicateLabels)].join(', ')}`);
  }

  return warnings;
}

function completedSlotCount(audit) {
  return (audit?.requiredSlotCompletion?.slots || []).filter((slot) => slot.status === 'completed').length;
}

function resolvedCitationCount(audit) {
  return audit?.citationIntegrity?.counts?.resolved ?? 0;
}

function realBodyCount(audit) {
  return audit?.evidenceProvenance?.counts?.realBodies ?? 0;
}

function buildDeltas(runs) {
  if (runs.length < 2) return null;

  const baseline = runs[0];
  return runs.slice(1).map((run) => ({
    strategyLabel: run.strategyLabel,
    versus: baseline.strategyLabel,
    durationMs: run.durationMs !== null && baseline.durationMs !== null
      ? run.durationMs - baseline.durationMs
      : null,
    llmTokens: run.cost.llmTokens - baseline.cost.llmTokens,
    searchRequests: run.cost.searchRequests - baseline.cost.searchRequests,
    sourceReads: run.cost.sourceReads - baseline.cost.sourceReads,
    rerankRequests: run.cost.rerankRequests - baseline.cost.rerankRequests,
    sourceCount: run.counts.sourceCount - baseline.counts.sourceCount,
    completedSlots: completedSlotCount(run.audit) - completedSlotCount(baseline.audit),
    resolvedCitations: resolvedCitationCount(run.audit) - resolvedCitationCount(baseline.audit),
    realBodies: realBodyCount(run.audit) - realBodyCount(baseline.audit),
    processContractPass: Boolean(run.audit?.processContract?.pass) === Boolean(baseline.audit?.processContract?.pass)
      ? 0
      : (run.audit?.processContract?.pass ? 1 : -1),
    status: run.audit?.status || null,
    baselineStatus: baseline.audit?.status || null,
  }));
}

export async function compareStrategySessions({
  sessions = [],
  researchIds = [],
  engine = null,
  strictPlatform = null,
  llm = null,
  llmEnabled = false,
  wallClockByWorkDir = new Map(),
}) {
  const targets = [];

  for (const session of sessions) {
    const [label, workDir] = session.includes('=')
      ? session.split('=').map((part) => part.trim())
      : [null, session.trim()];
    targets.push({ label, workDir, researchId: null });
  }

  for (const researchId of researchIds) {
    targets.push({ label: null, workDir: null, researchId });
  }

  if (targets.length < 2) {
    throw new Error('Strategy comparison requires at least two sessions or research IDs.');
  }

  const runs = [];
  for (const target of targets) {
    const artifacts = target.researchId
      ? loadArtifactsByResearchId(target.researchId, engine ? { engine } : {})
      : loadArtifacts(target.workDir);
    const wallClockDurationMs = target.workDir ? wallClockByWorkDir.get(target.workDir) ?? null : null;
    const stats = extractRunStats(artifacts, { wallClockDurationMs });
    if (target.label) stats.strategyLabel = target.label;

    const benchmark = await runBenchmark({
      workDir: target.workDir,
      researchId: target.researchId,
      engine,
      strictPlatform,
      llm,
      llmEnabled,
    });

    const audit = auditStrategyRun({
      query: artifacts.meta?.query || stats.query,
      strategy: stats.strategyLabel,
      report: artifacts.report,
      findings: artifacts.findings,
      sources: artifacts.sources,
      claims: artifacts.claims,
      passages: artifacts.passages,
      quality: artifacts.quality,
      trace: artifacts.trace,
      meta: artifacts.meta,
      usage: artifacts.quality?.budget?.usage || stats.cost,
    });

    runs.push({
      ...stats,
      audit,
      effectiveness: audit,
      benchmark: {
        evaluation: benchmark.evaluation,
        metrics: benchmark.metrics,
        artifactsHealth: benchmark.artifactsHealth,
      },
    });
  }

  const warnings = collectWarnings(runs);
  return {
    query: warnings.includes('Compared runs use different queries.') ? null : runs[0]?.query || null,
    comparedAt: new Date().toISOString(),
    warnings,
    runs,
    deltas: buildDeltas(runs),
  };
}
