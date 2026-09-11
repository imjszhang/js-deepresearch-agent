import { loadArtifacts, loadArtifactsByResearchId } from './load-artifacts.mjs';
import { runBenchmark } from './run-benchmark.mjs';
import { extractRunStats, resolveStrategyLabel } from './extract-run-stats.mjs';
import { auditStrategyRun } from './strategy-effectiveness.mjs';

function collectWarnings(runs) {
  const warnings = [];
  const queries = [...new Set(runs.map((run) => run.query).filter(Boolean))];
  const metricVersions = [...new Set(runs.map((run) => run.benchmark.metrics.metricsVersion))];
  const labels = runs.map((run) => run.strategyLabel);
  const duplicateLabels = labels.filter((label, index) => labels.indexOf(label) !== index);

  if (queries.length > 1) warnings.push('Compared runs use different queries.');
  if (runs.some((run) => !run.query)) warnings.push('A compared run has no recorded query; query equivalence is unverified.');
  if (metricVersions.length > 1) warnings.push('Compared runs use different artifact metrics versions.');
  if (duplicateLabels.length > 0) {
    warnings.push(`Duplicate strategy labels detected: ${[...new Set(duplicateLabels)].join(', ')}`);
  }

  return warnings;
}

function completedSlotCount(audit) {
  const slots = audit?.requiredSlotCompletion?.slots;
  return Array.isArray(slots) ? slots.filter((slot) => slot.status === 'completed').length : null;
}

function resolvedCitationCount(audit) {
  return audit?.citationIntegrity?.counts?.resolved ?? null;
}

function realBodyCount(audit) {
  return audit?.evidenceProvenance?.counts?.realBodies ?? null;
}

function difference(value, baseline) {
  return Number.isFinite(value) && Number.isFinite(baseline) ? value - baseline : null;
}

function costDifference(run, baseline, key) {
  if (run.cost.unknownUsage?.[key] || baseline.cost.unknownUsage?.[key]
    || (key === 'llmTokens' && (run.cost.costIsLowerBound || baseline.cost.costIsLowerBound))) return null;
  return difference(run.cost[key], baseline.cost[key]);
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
    llmTokens: costDifference(run, baseline, 'llmTokens'),
    searchRequests: costDifference(run, baseline, 'searchRequests'),
    sourceReads: costDifference(run, baseline, 'sourceReads'),
    rerankRequests: costDifference(run, baseline, 'rerankRequests'),
    sourceCount: difference(run.counts.sourceCount, baseline.counts.sourceCount),
    completedSlots: difference(completedSlotCount(run.audit), completedSlotCount(baseline.audit)),
    resolvedCitations: difference(resolvedCitationCount(run.audit), resolvedCitationCount(baseline.audit)),
    realBodies: difference(realBodyCount(run.audit), realBodyCount(baseline.audit)),
    processContractPass: typeof run.audit?.processContract?.pass !== 'boolean' || typeof baseline.audit?.processContract?.pass !== 'boolean'
      ? null : run.audit.processContract.pass === baseline.audit.processContract.pass
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
  llmEnabled = false,
  wallClockByWorkDir = new Map(),
}) {
  if (llmEnabled !== false) {
    throw new Error('Strategy artifact comparison is offline. Use benchmark:quality score --mode model-observation for independent model assessment.');
  }
  const targets = [];

  for (const session of sessions) {
    const separator = session.indexOf('=');
    const labelled = separator > 0 && !/[\\/]/.test(session.slice(0, separator));
    const [label, workDir] = labelled
      ? [session.slice(0, separator).trim(), session.slice(separator + 1).trim()]
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
    const displayLabel = target.label || stats.strategyLabel;
    if (target.label) stats.strategyLabel = target.label;

    const benchmark = await runBenchmark({
      artifacts,
      strictPlatform,
      llmEnabled: false,
    });

    const audit = auditStrategyRun({
      query: artifacts.meta?.query || stats.query,
      strategy: resolveStrategyLabel(artifacts),
      report: artifacts.report,
      findings: artifacts.findings,
      sources: artifacts.sources,
      claims: artifacts.claims,
      passages: artifacts.passages,
      citationRegistry: artifacts.citationRegistry,
      evidenceStore: artifacts.evidenceStore,
      gaps: artifacts.gaps,
      brief: artifacts.brief,
      quality: artifacts.quality,
      trace: artifacts.trace,
      meta: artifacts.meta,
      usage: artifacts.quality?.budget?.usage || stats.cost,
    });
    audit.scope = 'legacy_heuristic_diagnostics';
    audit.authoritative = false;

    runs.push({
      ...stats,
      displayLabel,
      runtimeDiagnostics: audit,
      audit,
      effectiveness: audit,
      benchmark: {
        schemaVersion: benchmark.schemaVersion,
        origin: benchmark.origin,
        artifactVerification: benchmark.artifactVerification,
        artifactMetadata: benchmark.artifactMetadata,
        modelAssessment: benchmark.modelAssessment,
        modelThresholdsMet: benchmark.modelThresholdsMet,
        metrics: benchmark.metrics,
        artifactsHealth: benchmark.artifactsHealth,
      },
    });
  }

  const warnings = collectWarnings(runs);
  return {
    schemaVersion: 2,
    origin: 'program_check',
    modelAssessment: { origin: 'model_assessment', observed: false, modelThresholdsMet: null },
    modelThresholdsMet: null,
    query: warnings.some((warning) => /queries|no recorded query/.test(warning)) ? null : runs[0]?.query || null,
    comparedAt: new Date().toISOString(),
    warnings,
    runs,
    deltas: buildDeltas(runs),
  };
}
