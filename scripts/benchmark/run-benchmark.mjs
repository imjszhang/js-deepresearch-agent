import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EvidenceStore, parseCitations, readArtifactManifest } from 'js-deepresearch-engine';
import { loadArtifacts, loadArtifactsByResearchId } from './load-artifacts.mjs';
import { summarizeFindingsHealth } from './rule-score.mjs';
import { verifyArtifact, ARTIFACT_VERIFICATION_VERSION } from './quality/artifact-verification.mjs';
import { loadResult, citedEvidence } from './quality/load-result.mjs';
import { hash } from './quality/schema.mjs';

export const BENCHMARK_SCHEMA_VERSION = 2;

function migrationError() {
  const error = new Error('Legacy live judging has been removed. Use benchmark:quality score --mode model-observation --program-verification <file> for an explicit independent model observation.');
  error.code = 'BENCHMARK_MODEL_OBSERVATION_REQUIRED';
  return error;
}

function integrityError(error) {
  const failure = new Error('Benchmark artifact integrity verification failed.', { cause: error });
  failure.code = 'BENCHMARK_ARTIFACT_INTEGRITY_INVALID';
  return failure;
}

function incompleteVerification(reason) {
  return { schemaVersion: ARTIFACT_VERIFICATION_VERSION, origin: 'program_check', status: 'incomplete',
    scope: 'declared_artifact_integrity', reason, resultPin: null,
    checks: { manifestAndBodies: null, declaredCitations: null, declaredClaimBindings: null, savedLedgerStructure: null },
    unavailable: { semanticTruth: true, extractionCompleteness: true, confirmedTokenReceiptSum: true } };
}

function frozenArtifact(artifacts, archived) {
  // The archive's committed identity takes precedence over any newer disk pointer.
  const run = artifacts.run;
  const paths = artifacts.artifactPaths;
  const sessionDir = run?.sessionDir || artifacts.workDir || paths?.sessionDir;
  const manifestPath = run ? run.resultManifestPath : paths?.manifestPath;
  const resultRevision = run ? run.resultRevision : paths?.resultRevision;
  if (!sessionDir || !manifestPath || !resultRevision) return {
    verification: incompleteVerification(archived || run ? 'ARCHIVED_RESULT_PIN_UNAVAILABLE' : 'VERSIONED_MANIFEST_UNAVAILABLE'),
    loaded: null,
  };
  const manifest = readArtifactManifest(sessionDir, manifestPath);
  if (manifest.resultRevision !== resultRevision) throw new Error('Committed artifact revision mismatch');
  if (manifest.schemaVersion !== 2) return { verification: incompleteVerification('VERSIONED_EVIDENCE_UNAVAILABLE'), loaded: null };
  const pin = { sessionDir: path.resolve(sessionDir), manifestPath: path.relative(sessionDir, manifest.manifestPath),
    manifestHash: hash(fs.readFileSync(manifest.manifestPath)), resultRevision };
  const loaded = loadResult(pin);
  if (run) {
    if (!run.resultSnapshotId || !artifacts.evidenceStore || !artifacts.citationRegistry) return {
      verification: incompleteVerification('ARCHIVED_SNAPSHOT_EVIDENCE_UNAVAILABLE'), loaded: null,
    };
    const arrayFields = ['findings', 'sources', 'gaps', 'passages', 'claims', 'trace'];
    const projectionFields = [...arrayFields, 'report', 'executionVersion', 'resultRevision', 'quality', 'brief', 'reportContract', 'reportPlan', 'evidenceAppendix'];
    if (projectionFields.some(field => loaded.result[field] !== undefined && !Object.hasOwn(artifacts, field))) return {
      verification: incompleteVerification('ARCHIVED_SNAPSHOT_FIELDS_UNAVAILABLE'), loaded: null,
    };
    // Compare canonical result fields, not normalized compatibility exports such
    // as claims.json, brief.json or quality.json. Absent optional empty values
    // can be normalized legitimately; actual measurements must remain identical.
    for (const field of projectionFields) {
      const fallback = arrayFields.includes(field) ? [] : null;
      if (!isDeepStrictEqual(artifacts[field] ?? fallback, loaded.result[field] ?? fallback)) {
        throw new Error('Archived result statistics do not match their committed revision');
      }
    }
    if (hash(new EvidenceStore(artifacts.evidenceStore).export()) !== hash(loaded.store.export())
      || hash(artifacts.citationRegistry) !== hash(loaded.registry)
      || hash(artifacts.reportPlan ?? null) !== hash(loaded.result.reportPlan ?? null)) {
      throw new Error('Archived evidence does not match its committed revision');
    }
  }
  // Do not combine an archived/previously loaded report with a different revision.
  if (typeof artifacts.report === 'string' && artifacts.report !== loaded.report) throw new Error('Loaded report does not match its committed revision');
  return { verification: verifyArtifact(pin), loaded };
}

/**
 * Verify observable artifact structure offline. Semantic observation has one
 * implementation in benchmark:quality; stored verdicts and keyword scores are
 * deliberately not inputs to this adapter.
 */
export async function runBenchmark({
  workDir,
  researchId = null,
  engine = null,
  strictPlatform = null,
  artifacts: suppliedArtifacts = null,
  llm = null,
  llmEnabled = false,
} = {}) {
  if (llmEnabled || llm) throw migrationError();
  let artifacts, frozen;
  try {
    artifacts = suppliedArtifacts || (researchId
      ? loadArtifactsByResearchId(researchId, engine ? { engine } : {})
      : loadArtifacts(workDir));
    frozen = frozenArtifact(artifacts, Boolean(researchId));
  } catch (error) {
    throw integrityError(error);
  }
  const result = frozen.loaded?.result || artifacts;
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const report = frozen.loaded?.report ?? artifacts.report ?? '';
  const observed = field => Boolean(frozen.loaded)
    || (artifacts.recordedFields?.[field] !== false && result[field] != null);
  const health = summarizeFindingsHealth(findings, sources);
  if (!observed('sources')) {
    health.sourceCount = null;
    health.enrichment = Object.fromEntries(Object.keys(health.enrichment).map(key => [key, null]));
    health.flags = health.flags.filter(flag => !['empty_sources', 'enrichment_all_failed', 'no_finding_sources'].includes(flag));
  }
  if (!observed('findings')) {
    for (const field of ['findingCount', 'findingErrors', 'findingsWithSources']) health[field] = null;
    health.flags = health.flags.filter(flag => !['all_findings_failed', 'no_finding_sources'].includes(flag));
  }
  const sourceHosts = new Set(sources.map(source => {
    try { return new URL(source.url).hostname; } catch { return null; }
  }).filter(Boolean));
  const citations = frozen.loaded ? citedEvidence(frozen.loaded) : null;
  const counts = frozen.verification.counts;
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    origin: 'program_check',
    query: artifacts.meta?.query || result.query || null,
    strategy: artifacts.meta?.strategy || result.strategy || null,
    researchId: researchId || artifacts.meta?.researchId || null,
    llmEnabled: false,
    evaluation: { mode: 'artifact-verification', llmEnabled: false, llmInvoked: false,
      usedStoredRule: false, usedStoredLlm: false, usedRuntimeRule: false, usedRuntimeLlm: false },
    artifactVerification: frozen.verification,
    modelAssessment: { origin: 'model_assessment', observed: false, modelThresholdsMet: null, reason: 'MODEL_OBSERVATION_NOT_REQUESTED' },
    artifactMetadata: { executionVersion: result.executionVersion ?? artifacts.meta?.executionVersion ?? null,
      resultRevision: frozen.verification.resultPin?.resultRevision || artifacts.run?.resultRevision || null,
      inputFormat: frozen.loaded ? 'versioned_manifest' : 'unversioned_artifacts' },
    artifactsHealth: { ...health, origin: 'program_check', scope: 'source_field_diagnostics' },
    metrics: {
      metricsVersion: BENCHMARK_SCHEMA_VERSION,
      sourceCount: observed('sources') ? sources.length : null,
      sourceHostCount: observed('sources') ? sourceHosts.size : null,
      passageCount: counts?.passages ?? (observed('passages') && Array.isArray(result.passages) ? result.passages.length : null),
      documentVersionCount: counts?.documentVersions ?? null,
      citationEntryCount: counts?.citationEntries ?? null,
      reportCitationCount: observed('report') ? parseCitations(report).length : null,
      resolvedCitationCount: citations ? citations.filter(c => c.resolved).length : null,
      citationResolutionRate: citations?.length ? citations.filter(c => c.resolved).length / citations.length : null,
      reportCharacterCount: observed('report') ? report.length : null,
      enrichOkRate: health.enrichment.enrichAttempted ? health.enrichment.enrichOkRate : null,
      contentPresenceRate: sources.length ? health.enrichment.contentRate : null,
      platformMatchRate: observed('sources') && strictPlatform && sources.length ? sources.filter(s => s.engine === strictPlatform).length / sources.length : null,
    },
  };
}
