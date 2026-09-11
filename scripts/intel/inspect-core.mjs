import { getIntelStoreEngine, readArchivedResearch } from '../../src/storage/intel-store.mjs';

function runTimestamp(run) {
  return run.archivedAt || run.last_seen || run.first_seen || '';
}

export function listArchivedRuns(engine = getIntelStoreEngine(), { limit = 50 } = {}) {
  const runs = engine.readSource('research_runs') || [];
  return [...runs]
    .sort((a, b) => runTimestamp(b).localeCompare(runTimestamp(a)))
    .slice(0, limit)
    .map((run) => ({
      researchId: run.name,
      strategy: run.strategy,
      query: run.query,
      status: run.status,
      sourcesCount: run.sourcesCount ?? 0,
      findingsCount: run.findingsCount ?? 0,
      passagesCount: run.passagesCount ?? 0,
      claimsCount: run.claimsCount ?? 0,
      sessionDir: run.sessionDir,
      archivedAt: run.archivedAt ?? run.last_seen ?? run.first_seen,
    }));
}

export function showArchivedRun(researchId, engine = getIntelStoreEngine()) {
  const run = engine.readSource('research_runs', { name: researchId });
  if (!run) {
    throw new Error(`Archived research run not found: ${researchId}`);
  }

  const archived = readArchivedResearch(researchId, engine);
  const { reportMeta, findings, sources, quality } = archived;

  return {
    researchId: run.name,
    query: run.query,
    strategy: run.strategy,
    status: run.status,
    sessionDir: run.sessionDir,
    reportPath: reportMeta?.reportPath ?? run.reportPath,
    reportLength: reportMeta?.reportLength ?? run.reportLength,
    findingsCount: findings.length,
    sourcesCount: sources.length,
    gapsCount: archived.gaps?.length || 0,
    passagesCount: archived.passages?.length || 0,
    claimsCount: archived.claims?.length || 0,
    qualityGate: quality?.gate ?? null,
    archiveSchemaVersion: run.archiveSchemaVersion ?? 2,
    archivedAt: run.archivedAt ?? run.last_seen ?? run.first_seen,
    settings: run.settings ?? {},
  };
}

export function listArchivedSources(researchId, engine = getIntelStoreEngine(), { limit = 20 } = {}) {
  const sources = readArchivedResearch(researchId, engine).sources || [];
  return sources.slice(0, limit).map((source) => {
    const rest = { ...source };
    for (const key of ['_post_id', '_entity_id', 'dedup_id']) delete rest[key];
    return {
      title: rest.title ?? '',
      url: rest.url ?? '',
      snippet: rest.snippet ?? '',
      engine: rest.engine ?? '',
    };
  });
}

export function listArchivedFindings(researchId, engine = getIntelStoreEngine(), { limit = 20 } = {}) {
  const findings = readArchivedResearch(researchId, engine).findings || [];
  return [...findings]
    .sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0))
    .slice(0, limit)
    .map((finding) => ({
      question: finding.question ?? '',
      iteration: finding.iteration ?? null,
      error: finding.error ?? null,
      sourceCount: Array.isArray(finding.sources) ? finding.sources.length : 0,
    }));
}
