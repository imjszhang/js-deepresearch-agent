import fs from 'node:fs';
import path from 'node:path';
import {
  QUALITY_METRICS_VERSION,
  CLAIM_EXTRACTION_VERSION,
  CLAIM_EVALUATION_VERSION,
} from './claim-quality.mjs';
import { publicSearchOptionsSnapshot } from '../search/normalize-search-config.mjs';

function atomicWriteFile(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* retain original error */ }
    throw error;
  }
}

function snapshotCorpusDirs(settings = {}) {
  const rawDirs = settings?.search?.local?.dirs;
  if (!Array.isArray(rawDirs) || rawDirs.length === 0) return [];
  const dirs = [];
  const seen = new Set();
  for (const dir of rawDirs) {
    const text = String(dir || '').trim();
    if (!text) continue;
    const resolved = path.resolve(text);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    dirs.push(resolved);
  }
  return dirs;
}

function snapshotResearchProviders(settings = {}) {
  const providers = settings?.research?.providers || {};
  const safe = (provider = {}) => ({
    provider: provider.provider || null,
    model: provider.model || null,
  });
  return {
    rerank: safe(providers.rerank),
    embedding: safe(providers.embedding),
  };
}

export function resolveWorkDir(settings, cwd = process.cwd()) {
  const configured = settings?.research?.workDir || 'work_dir';
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(cwd, configured);
}

export function formatSessionTimestamp(date = new Date()) {
  const iso = date.toISOString();
  const [day, timePart] = iso.slice(0, 19).split('T');
  return `${day}_${timePart.replace(/:/g, '')}`;
}

export function createWorkSessionDir({ settings, strategy, cwd = process.cwd(), date = new Date() }) {
  const workDir = resolveWorkDir(settings, cwd);
  const strategyDir = path.join(workDir, strategy);
  fs.mkdirSync(strategyDir, { recursive: true });
  const timestamp = formatSessionTimestamp(date);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${String(attempt).padStart(3, '0')}`;
    const sessionDir = path.join(strategyDir, `${timestamp}${suffix}`);
    try {
      fs.mkdirSync(sessionDir);
      return sessionDir;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Unable to allocate a unique work session directory for ${strategy}/${timestamp}.`);
}

export function saveResearchArtifacts({
  sessionDir,
  query,
  strategy,
  settings,
  result,
  researchId = null,
}) {
  fs.mkdirSync(sessionDir, { recursive: true });

  const artifacts = {
    sessionDir,
    reportPath: path.join(sessionDir, 'report.md'),
    findingsPath: path.join(sessionDir, 'findings.json'),
    sourcesPath: path.join(sessionDir, 'sources.json'),
    metaPath: path.join(sessionDir, 'meta.json'),
    briefPath: path.join(sessionDir, 'brief.json'),
    gapsPath: path.join(sessionDir, 'gaps.json'),
    passagesPath: path.join(sessionDir, 'passages.json'),
    claimsPath: path.join(sessionDir, 'claims.json'),
    qualityPath: path.join(sessionDir, 'quality.json'),
    tracePath: path.join(sessionDir, 'trace.json'),
    reportPlanPath: path.join(sessionDir, 'report-plan.json'),
  };

  atomicWriteFile(artifacts.reportPath, result.report);
  atomicWriteFile(artifacts.findingsPath, JSON.stringify(result.findings, null, 2));
  atomicWriteFile(artifacts.sourcesPath, JSON.stringify(result.sources, null, 2));
  atomicWriteFile(artifacts.briefPath, JSON.stringify(result.brief || {
    schemaVersion: 1,
    query,
    depth: strategy,
  }, null, 2));
  atomicWriteFile(artifacts.gapsPath, JSON.stringify(result.gaps || [], null, 2));
  atomicWriteFile(artifacts.passagesPath, JSON.stringify(result.passages || [], null, 2));
  atomicWriteFile(artifacts.claimsPath, JSON.stringify((result.claims || []).map((claim) => ({
    ...claim,
    canonicalClaimId: claim.canonicalClaimId || null,
    placements: claim.placements || [],
    boundSlotIds: claim.boundSlotIds || [],
    origin: claim.origin || claim.evaluation?.origin || null,
  })), null, 2));
  atomicWriteFile(artifacts.qualityPath, JSON.stringify(result.quality || { schemaVersion: 4, gate: 'pass', flags: [] }, null, 2));
  atomicWriteFile(artifacts.tracePath, JSON.stringify(result.trace || [], null, 2));
  atomicWriteFile(artifacts.reportPlanPath, JSON.stringify(result.reportPlan || {
    schemaVersion: 1,
    contract: result.reportContract || null,
    claims: result.claims || [],
  }, null, 2));
  atomicWriteFile(
    artifacts.metaPath,
    JSON.stringify(
      {
        query,
        strategy,
        researchId,
        artifactSchemaVersion: 4,
        researchBrief: result.brief || null,
        qualityMetricsVersion: result.quality?.qualityMetricsVersion || QUALITY_METRICS_VERSION,
        claimExtractionVersion: result.quality?.claimExtractionVersion || CLAIM_EXTRACTION_VERSION,
        claimEvaluationVersion: result.quality?.claimEvaluationVersion || CLAIM_EVALUATION_VERSION,
        createdAt: new Date().toISOString(),
        artifacts: {
          gapsPath: artifacts.gapsPath,
          briefPath: artifacts.briefPath,
          passagesPath: artifacts.passagesPath,
          claimsPath: artifacts.claimsPath,
          qualityPath: artifacts.qualityPath,
          tracePath: artifacts.tracePath,
          reportPlanPath: artifacts.reportPlanPath,
        },
        settings: {
          iterations: settings.research?.iterations,
          questionsPerIteration: settings.research?.questionsPerIteration,
          concurrency: settings.research?.concurrency,
          budget: settings.research?.budget,
          providers: snapshotResearchProviders(settings),
          relevance: settings.research?.read?.relevance || null,
          searchEngine: settings.search?.engine || null,
          search: publicSearchOptionsSnapshot(settings.search),
          corpusDirs: snapshotCorpusDirs(settings),
        },
      },
      null,
      2,
    ),
  );

  return artifacts;
}

export function saveResearchToWorkDir({
  settings,
  strategy,
  query,
  result,
  researchId = null,
  cwd = process.cwd(),
  date = new Date(),
}) {
  const sessionDir = createWorkSessionDir({ settings, strategy, cwd, date });
  return saveResearchArtifacts({
    sessionDir,
    query,
    strategy,
    settings,
    result,
    researchId,
  });
}
