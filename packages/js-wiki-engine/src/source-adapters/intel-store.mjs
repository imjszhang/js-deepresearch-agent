import { EvidenceStore, buildCitationMap } from 'js-deepresearch-engine';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWikiSource } from '../schema.mjs';

function stripJsonlEntityFields(record) {
  const rest = { ...record };
  for (const key of ['_post_id', '_entity_id', '_seq', 'dedup_id', 'raw', 'archivedAt']) delete rest[key];
  return rest;
}

function artifactPathsFromRun(run, reportMeta) {
  const sessionDir = run?.sessionDir;
  const reportPath = reportMeta?.reportPath ?? run?.reportPath ?? null;

  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return {
      report: reportPath,
      findings: null,
      sources: null,
    };
  }

  return {
    report: reportPath || path.join(sessionDir, 'report.md'),
    findings: run?.findingsPath || path.join(sessionDir, 'findings.json'),
    sources: run?.sourcesPath || path.join(sessionDir, 'sources.json'),
  };
}

function resolveReportFromIntel(run, reportMeta) {
  if (typeof reportMeta?.report === 'string' && reportMeta.report.length > 0) {
    return reportMeta.report;
  }

  const reportPath = reportMeta?.reportPath || run?.reportPath;
  if (reportPath && fs.existsSync(reportPath)) {
    return fs.readFileSync(reportPath, 'utf8');
  }

  return '';
}

/**
 * Load normalized wiki sources (and report/meta) from a js-intel-store StorageEngine.
 * @param {{ engine: import('js-intel-store').StorageEngine, researchId: string }} params
 */
export function loadSourcesFromIntelStore({ engine, researchId }) {
  if (!engine) throw new Error('loadSourcesFromIntelStore requires engine');
  if (!researchId) throw new Error('loadSourcesFromIntelStore requires researchId');

  const run = engine.readSource('research_runs', { name: researchId });
  if (!run) {
    throw new Error(`Archived research run not found: ${researchId}`);
  }

  const snapshot = run.resultSnapshotId
    ? engine.readSource('research_result_snapshots', { name: run.resultSnapshotId })?.result : null;
  if (run.resultSnapshotId && !snapshot) throw new Error('Archived result snapshot is missing');
  const evidence = snapshot?.evidenceStore ? new EvidenceStore(snapshot.evidenceStore) : null;
  if (snapshot?.citationRegistry) buildCitationMap([], { citationRegistry: snapshot.citationRegistry, sources: snapshot.sources, evidenceStore: evidence });
  const sourcesRaw = snapshot ? snapshot.sources : (engine.readSource('research_sources', { entity_id: researchId }) || []);
  const reportMeta = snapshot ? { report: snapshot.report, reportPath: run.reportPath } : engine.readSource('research_reports', { name: researchId });
  const safeRead = (name) => {
    try { return (engine.readSource(name, { entity_id: researchId }) || []).map(stripJsonlEntityFields); }
    catch { return []; }
  };
  const claims = snapshot ? snapshot.claims || [] : safeRead('research_claims');
  const passages = snapshot ? snapshot.passages || [] : safeRead('research_passages');
  const gaps = snapshot ? snapshot.gaps || [] : safeRead('research_gaps');
  let quality = null;
  try { quality = snapshot ? snapshot.quality : engine.readSource('research_quality', { name: researchId }); } catch { /* v2 store */ }

  const report = resolveReportFromIntel(run, reportMeta);
  const artifactPaths = artifactPathsFromRun(run, reportMeta);
  const query = run.query ?? '';
  const strategy = run.strategy ?? '';

  const sources = [...sourcesRaw]
    .sort((a, b) => (a.sourceIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceIndex ?? Number.MAX_SAFE_INTEGER))
    .map((record, index) => {
      const raw = stripJsonlEntityFields(record);
      const sourceIndex = raw.sourceIndex ?? index + 1;
      return normalizeWikiSource({
        ...raw,
        researchId,
        query,
        strategy,
        sourceIndex,
        artifactPaths,
        tags: ['source', strategy].filter(Boolean),
        observedAt: raw.archivedAt ?? run.archivedAt ?? run.last_seen ?? run.first_seen,
      }, index);
    });

  return {
    researchId,
    query,
    strategy,
    meta: {
      query,
      strategy,
      researchId,
      sessionDir: run.sessionDir ?? null,
      status: run.status,
      archiveSchemaVersion: run.archiveSchemaVersion ?? null,
      researchBrief: run.researchBrief ?? null,
    },
    brief: run.researchBrief ?? null,
    report,
    sources,
    citationRegistry: snapshot?.citationRegistry || null,
    evidenceStore: evidence?.export() || null,
    claims,
    passages,
    gaps,
    quality,
  };
}
