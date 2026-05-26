import fs from 'node:fs';
import path from 'node:path';
import { normalizeWikiSource } from '../schema.mjs';

function stripJsonlEntityFields(record) {
  const { _post_id, _entity_id, _seq, dedup_id, raw, archivedAt, ...rest } = record;
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
    report: path.join(sessionDir, 'report.md'),
    findings: path.join(sessionDir, 'findings.json'),
    sources: path.join(sessionDir, 'sources.json'),
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

  const sourcesRaw = engine.readSource('research_sources', { entity_id: researchId }) || [];
  const reportMeta = engine.readSource('research_reports', { name: researchId });

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
    },
    report,
    sources,
  };
}
