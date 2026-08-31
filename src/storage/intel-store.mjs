import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DataSourceSpec,
  DataSourceRegistry,
  StorageEngine,
} from 'js-intel-store';

export const DEFAULT_INTEL_BASE_DIR = 'data/intel';
export const ARCHIVE_SCHEMA_VERSION = 3;

export function resolveIntelBaseDir(baseDir) {
  return baseDir ?? process.env.JDR_INTEL_STORE_DIR ?? DEFAULT_INTEL_BASE_DIR;
}

export function createResearchIntelRegistry() {
  return new DataSourceRegistry().registerAll([
    new DataSourceSpec({
      name: 'research_runs',
      storageType: 'entity_json',
      description: 'Research run summaries keyed by researchId',
    }),
    new DataSourceSpec({
      name: 'research_findings',
      storageType: 'entity_jsonl',
      dedupKey: 'dedup_id',
      description: 'Findings per research run',
    }),
    new DataSourceSpec({
      name: 'research_sources',
      storageType: 'entity_jsonl',
      dedupKey: 'dedup_id',
      description: 'Sources per research run, deduped by dedup_id',
    }),
    new DataSourceSpec({
      name: 'research_reports',
      storageType: 'entity_json',
      description: 'Report metadata per research run',
    }),
    new DataSourceSpec({ name: 'research_gaps', storageType: 'entity_jsonl', dedupKey: 'dedup_id', description: 'Research gaps per run' }),
    new DataSourceSpec({ name: 'research_passages', storageType: 'entity_jsonl', dedupKey: 'dedup_id', description: 'Source passages per run' }),
    new DataSourceSpec({ name: 'research_claims', storageType: 'entity_jsonl', dedupKey: 'dedup_id', description: 'Report claims per run' }),
    new DataSourceSpec({ name: 'research_quality', storageType: 'entity_json', description: 'Quality summary per run' }),
    new DataSourceSpec({ name: 'research_trace', storageType: 'entity_jsonl', dedupKey: 'dedup_id', description: 'Structured research trace per run' }),
  ]);
}

export function createIntelStoreEngine({ baseDir, timezone = 'UTC' } = {}) {
  const configured = resolveIntelBaseDir(baseDir);
  const resolvedBase = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(process.cwd(), configured);

  return new StorageEngine({
    baseDir: resolvedBase,
    registry: createResearchIntelRegistry(),
    timezone,
  });
}

let defaultEngine;

export function getIntelStoreEngine(options = {}) {
  if (!defaultEngine || options.baseDir) {
    defaultEngine = createIntelStoreEngine(options);
  }
  return defaultEngine;
}

export function resetIntelStoreEngine() {
  defaultEngine = undefined;
}

export function sourceDedupId(source, index = 0) {
  const url = String(source?.url ?? '').trim();
  if (url) return url;
  const title = String(source?.title ?? '').trim();
  const snippet = String(source?.snippet ?? '').trim();
  const content = String(source?.content ?? source?.summary ?? '').trim();
  if (title || snippet || content) {
    return crypto.createHash('sha256').update(`${title}:${snippet}:${content}`).digest('hex');
  }
  return `unknown-${index}`;
}

function buildSourceArchiveFields(source, index, archivedAt) {
  const content = String(source?.content ?? source?.summary ?? '').trim();
  return {
    sourceIndex: index + 1,
    fetchStatus: source?.fetchStatus ?? null,
    fetchError: source?.fetchError ?? null,
    hasContent: content.length > 0,
    contentLength: content.length,
    archivedAt,
  };
}

function resolveResearchBrief(result, artifacts = null) {
  if (result?.brief && typeof result.brief === 'object') return result.brief;
  const briefPath = artifacts?.briefPath;
  if (briefPath && fs.existsSync(briefPath)) {
    try {
      return JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function resolveArchivedReport(run, reportMeta) {
  if (typeof reportMeta?.report === 'string' && reportMeta.report.length > 0) {
    return reportMeta.report;
  }

  const reportPath = reportMeta?.reportPath || run?.reportPath;
  if (reportPath && fs.existsSync(reportPath)) {
    return fs.readFileSync(reportPath, 'utf8');
  }

  return '';
}

function flattenFindings(findings, researchId) {
  if (!Array.isArray(findings)) return [];
  return findings.map((finding, seq) => ({
    _entity_id: researchId,
    _seq: seq,
    dedup_id: finding?.id || crypto.createHash('sha256').update(`${finding?.question || ''}:${finding?.iteration || ''}`).digest('hex'),
    question: finding?.question ?? null,
    iteration: finding?.iteration ?? null,
    error: finding?.error ?? null,
    sources: finding?.sources ?? [],
    raw: finding,
  }));
}

function reconstructFindings(records) {
  if (!records?.length) return [];
  return [...records]
    .sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0))
    .map((record) => {
      if (record.raw && typeof record.raw === 'object') {
        return record.raw;
      }
      return {
        question: record.question,
        iteration: record.iteration,
        error: record.error,
        sources: record.sources,
      };
    });
}

function stripEntityJsonlFields(record) {
  const rest = { ...record };
  for (const key of ['_post_id', '_entity_id', '_seq', 'dedup_id', 'raw']) delete rest[key];
  return rest;
}

function entityRecords(items, researchId, fallbackPrefix) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    ...item,
    _entity_id: researchId,
    _seq: index,
    dedup_id: item?.id || item?.contentHash || `${fallbackPrefix}-${index}`,
  }));
}

/**
 * Archive a completed research result into js-intel-store.
 * @returns {{ ok: boolean, researchId?: string, reason?: string, error?: string }}
 */
export function archiveResearchResult({
  researchId,
  query,
  strategy,
  result,
  artifacts = null,
  settings = {},
  engine = getIntelStoreEngine(),
}) {
  if (!researchId) {
    return { ok: false, reason: 'missing researchId' };
  }

  const archivedAt = new Date().toISOString();
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  const gaps = Array.isArray(result?.gaps) ? result.gaps : [];
  const passages = Array.isArray(result?.passages) ? result.passages : [];
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const trace = Array.isArray(result?.trace) ? result.trace : [];

  engine.ingest('research_runs', {
    name: researchId,
    query,
    strategy,
    status: 'completed',
    archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
    qualityMetricsVersion: result?.quality?.qualityMetricsVersion ?? result?.quality?.metrics?.metricsVersion ?? 1,
    claimExtractionVersion: result?.quality?.claimExtractionVersion ?? result?.quality?.metrics?.claimExtractionVersion ?? 1,
    claimEvaluationVersion: result?.quality?.claimEvaluationVersion ?? result?.quality?.metrics?.claimEvaluationVersion ?? 1,
    sessionDir: artifacts?.sessionDir ?? null,
    reportPath: artifacts?.reportPath ?? null,
    findingsPath: artifacts?.findingsPath ?? null,
    sourcesPath: artifacts?.sourcesPath ?? null,
    metaPath: artifacts?.metaPath ?? null,
    briefPath: artifacts?.briefPath ?? null,
    researchBrief: resolveResearchBrief(result, artifacts),
    findingsCount: findings.length,
    sourcesCount: sources.length,
    gapsCount: gaps.length,
    passagesCount: passages.length,
    claimsCount: claims.length,
    reportLength: result?.report?.length ?? 0,
    settings: {
      iterations: settings?.research?.iterations,
      questionsPerIteration: settings?.research?.questionsPerIteration,
      concurrency: settings?.research?.concurrency,
      budget: settings?.research?.budget,
    },
    archivedAt,
  });

  const findingRecords = flattenFindings(findings, researchId);
  if (findingRecords.length > 0) {
    engine.ingest('research_findings', findingRecords);
  }

  if (sources.length > 0) {
    engine.ingest(
      'research_sources',
      sources.map((source, index) => ({
        ...source,
        _entity_id: researchId,
        dedup_id: sourceDedupId(source, index),
        ...buildSourceArchiveFields(source, index, archivedAt),
      })),
    );
  }

  for (const [name, records] of [
    ['research_passages', entityRecords(passages, researchId, 'passage')],
    ['research_gaps', entityRecords(gaps, researchId, 'gap')],
    ['research_claims', entityRecords(claims, researchId, 'claim')],
    ['research_trace', entityRecords(trace, researchId, 'trace')],
  ]) {
    if (records.length > 0) engine.ingest(name, records);
  }

  engine.ingest('research_quality', {
    name: researchId,
    ...(result?.quality || { schemaVersion: ARCHIVE_SCHEMA_VERSION, gate: 'pass', flags: [] }),
    archivedAt,
  });

  engine.ingest('research_reports', {
    name: researchId,
    report: result?.report ?? '',
    reportPath: artifacts?.reportPath ?? null,
    reportLength: result?.report?.length ?? 0,
    sessionDir: artifacts?.sessionDir ?? null,
    archivedAt,
  });

  return { ok: true, researchId };
}

/**
 * Archive without failing the caller; logs warnings via onWarning.
 */
export async function archiveResearchResultSafe(params, { onWarning } = {}) {
  try {
    return archiveResearchResult(params);
  } catch (error) {
    const message = error?.message || String(error);
    onWarning?.(message);
    return { ok: false, error: message };
  }
}

export function readArchivedResearch(researchId, engine = getIntelStoreEngine()) {
  const run = engine.readSource('research_runs', { name: researchId });
  if (!run) {
    throw new Error(`Archived research run not found: ${researchId}`);
  }

  const findingsRaw = engine.readSource('research_findings', { entity_id: researchId });
  const sourcesRaw = engine.readSource('research_sources', { entity_id: researchId });
  const reportMeta = engine.readSource('research_reports', { name: researchId });
  const warnings = [];
  const safeReadMany = (name) => {
    try { return engine.readSource(name, { entity_id: researchId }) || []; }
    catch (error) { warnings.push(`${name}: ${error.message}`); return []; }
  };
  const gapsRaw = safeReadMany('research_gaps');
  const passagesRaw = safeReadMany('research_passages');
  const claimsRaw = safeReadMany('research_claims');
  const traceRaw = safeReadMany('research_trace');
  let quality = null;
  try { quality = engine.readSource('research_quality', { name: researchId }); }
  catch (error) { warnings.push(`research_quality: ${error.message}`); }

  const report = resolveArchivedReport(run, reportMeta);

  const meta = {
    query: run.query,
    strategy: run.strategy,
    researchId,
    createdAt: run.first_seen ?? run.archivedAt,
    settings: run.settings ?? {},
    sessionDir: run.sessionDir ?? null,
    researchBrief: run.researchBrief ?? null,
  };

  return {
    workDir: run.sessionDir ?? null,
    meta,
    brief: run.researchBrief ?? null,
    findings: reconstructFindings(findingsRaw),
    sources: sourcesRaw.map(stripEntityJsonlFields),
    gaps: gapsRaw.map(stripEntityJsonlFields),
    passages: passagesRaw.map(stripEntityJsonlFields),
    claims: claimsRaw.map(stripEntityJsonlFields),
    quality: quality || { schemaVersion: run.archiveSchemaVersion || 2, gate: 'pass', flags: [] },
    trace: traceRaw.map(stripEntityJsonlFields),
    archiveWarnings: warnings,
    report,
    run,
    reportMeta,
  };
}

export function loadArtifactsByResearchId(researchId, options = {}) {
  return readArchivedResearch(researchId, options.engine ?? getIntelStoreEngine(options));
}
