import fs from 'node:fs';
import path from 'node:path';
import { loadArtifacts } from '../benchmark/load-artifacts.mjs';
import { archiveResearchResult } from '../../src/storage/intel-store.mjs';
import { buildEvidenceArtifacts, matchesStrategyFilter, sessionMatchesStrategyFilter } from 'js-deepresearch-engine';

const REQUIRED_FILES = ['report.md', 'findings.json', 'sources.json', 'meta.json'];
const SESSION_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

export function buildImportedResearchId(strategy, timestamp) {
  return `imported__${strategy}__${timestamp}`;
}

export function resolveResearchId(meta, strategy, timestamp) {
  if (meta?.researchId) return meta.researchId;
  return buildImportedResearchId(strategy, timestamp);
}

function hasRequiredArtifacts(sessionDir) {
  return REQUIRED_FILES.every((file) => fs.existsSync(path.join(sessionDir, file)));
}

/**
 * @param {{ root: string, strategyFilter?: string|null }} options
 * @returns {Array<{ strategy: string, timestamp: string, sessionDir: string }>}
 */
export function discoverWorkDirSessions({ root, strategyFilter = null }) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    return [];
  }

  const sessions = [];
  const strategies = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => matchesStrategyFilter(name, strategyFilter));

  for (const strategy of strategies) {
    const strategyDir = path.join(resolvedRoot, strategy);
    const timestamps = fs.readdirSync(strategyDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);

    for (const timestamp of timestamps) {
      if (!SESSION_DIR_PATTERN.test(timestamp)) continue;
      const sessionDir = path.join(strategyDir, timestamp);
      const { meta, trace } = readSessionStrategyContext(sessionDir);
      if (!sessionMatchesStrategyFilter({ directoryName: strategy, meta, trace }, strategyFilter)) {
        continue;
      }
      sessions.push({
        strategy,
        timestamp,
        sessionDir,
      });
    }
  }

  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function readSessionStrategyContext(sessionDir) {
  const meta = readJsonIfPresent(path.join(sessionDir, 'meta.json'));
  const trace = readJsonIfPresent(path.join(sessionDir, 'trace.json'));
  return {
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    trace: Array.isArray(trace) ? trace : undefined,
  };
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   root?: string,
 *   strategyFilter?: string|null,
 *   dryRun?: boolean,
 *   skipExisting?: boolean,
 *   upgradeExisting?: boolean,
 *   engine: import('js-intel-store').StorageEngine,
 * }} options
 */
export function importWorkDirSessions({
  root = 'work_dir',
  strategyFilter = null,
  dryRun = false,
  skipExisting = true,
  upgradeExisting = false,
  engine,
}) {
  const sessions = discoverWorkDirSessions({ root, strategyFilter });
  const summary = {
    scanned: sessions.length,
    imported: 0,
    upgraded: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    items: [],
  };

  for (const { strategy, timestamp, sessionDir } of sessions) {
    const item = {
      strategy,
      timestamp,
      sessionDir,
      status: 'pending',
      researchId: null,
      reason: null,
    };

    try {
      if (!hasRequiredArtifacts(sessionDir)) {
        item.status = 'skipped';
        item.reason = 'missing required artifact files';
        summary.skipped += 1;
        summary.items.push(item);
        continue;
      }

      const artifacts = loadArtifacts(sessionDir);
      const researchId = resolveResearchId(artifacts.meta, strategy, timestamp);
      item.researchId = researchId;

      const existing = engine.readSource('research_runs', { name: researchId });
      if (existing && skipExisting && !upgradeExisting) {
        item.status = 'skipped';
        item.reason = 'already archived';
        summary.skipped += 1;
        summary.items.push(item);
        continue;
      }

      if (dryRun) {
        item.status = existing ? 'dry-run-upgrade' : 'dry-run';
        const derived = upgradeExisting && (!artifacts.passages?.length || !artifacts.claims?.length)
          ? buildEvidenceArtifacts({ query: artifacts.meta?.query ?? '', findings: artifacts.findings, report: artifacts.report, options: { maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true } })
          : null;
        item.preview = {
          gaps: artifacts.gaps?.length || 0,
          passages: artifacts.passages?.length || derived?.passages.length || 0,
          claims: artifacts.claims?.length || derived?.claims.length || 0,
          upgradeWarnings: derived && derived.passages.length === 0 ? ['No source content available; no passages derived.'] : [],
        };
        if (existing) {
          summary.upgraded += 1;
        } else {
          summary.imported += 1;
        }
        summary.items.push(item);
        continue;
      }

      const result = {
        report: artifacts.report,
        findings: artifacts.findings,
        sources: artifacts.sources,
        gaps: artifacts.gaps || [],
        passages: artifacts.passages || [],
        claims: artifacts.claims || [],
        quality: artifacts.quality || undefined,
        trace: artifacts.trace || [],
      };

      if (upgradeExisting && result.passages.length === 0 && result.claims.length === 0) {
        const derived = buildEvidenceArtifacts({
          query: artifacts.meta?.query ?? '',
          findings: result.findings,
          report: result.report,
          options: { maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true },
        });
        result.findings = derived.findings;
        result.sources = derived.sources.length ? derived.sources : result.sources;
        result.passages = derived.passages;
        result.claims = derived.claims;
        result.quality ||= { schemaVersion: 3, gate: 'pass_with_warnings', flags: ['upgraded_from_v2'], metrics: {}, budget: {}, limitations: [] };
      }

      archiveResearchResult({
        researchId,
        query: artifacts.meta?.query ?? '',
        strategy: artifacts.meta?.strategy ?? strategy,
        result,
        artifacts: {
          sessionDir: artifacts.workDir,
          reportPath: path.join(sessionDir, 'report.md'),
          findingsPath: path.join(sessionDir, 'findings.json'),
          sourcesPath: path.join(sessionDir, 'sources.json'),
          metaPath: path.join(sessionDir, 'meta.json'),
          gapsPath: path.join(sessionDir, 'gaps.json'),
          passagesPath: path.join(sessionDir, 'passages.json'),
          claimsPath: path.join(sessionDir, 'claims.json'),
          qualityPath: path.join(sessionDir, 'quality.json'),
          tracePath: path.join(sessionDir, 'trace.json'),
        },
        settings: { research: artifacts.meta?.settings ?? {} },
        engine,
      });

      item.status = existing ? 'upgraded' : 'imported';
      if (existing) {
        summary.upgraded += 1;
      } else {
        summary.imported += 1;
      }
    } catch (error) {
      item.status = 'failed';
      item.reason = error?.message || String(error);
      summary.failed += 1;
    }

    summary.items.push(item);
  }

  return summary;
}
