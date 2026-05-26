import fs from 'node:fs';
import path from 'node:path';
import { loadArtifacts } from '../benchmark/load-artifacts.mjs';
import { archiveResearchResult } from '../../src/storage/intel-store.mjs';

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
    .filter((name) => !strategyFilter || name === strategyFilter);

  for (const strategy of strategies) {
    const strategyDir = path.join(resolvedRoot, strategy);
    const timestamps = fs.readdirSync(strategyDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);

    for (const timestamp of timestamps) {
      if (!SESSION_DIR_PATTERN.test(timestamp)) continue;
      sessions.push({
        strategy,
        timestamp,
        sessionDir: path.join(strategyDir, timestamp),
      });
    }
  }

  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * @param {{
 *   root?: string,
 *   strategyFilter?: string|null,
 *   dryRun?: boolean,
 *   skipExisting?: boolean,
 *   engine: import('js-intel-store').StorageEngine,
 * }} options
 */
export function importWorkDirSessions({
  root = 'work_dir',
  strategyFilter = null,
  dryRun = false,
  skipExisting = true,
  engine,
}) {
  const sessions = discoverWorkDirSessions({ root, strategyFilter });
  const summary = {
    scanned: sessions.length,
    imported: 0,
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
      if (skipExisting && existing) {
        item.status = 'skipped';
        item.reason = 'already archived';
        summary.skipped += 1;
        summary.items.push(item);
        continue;
      }

      if (dryRun) {
        item.status = 'dry-run';
        summary.imported += 1;
        summary.items.push(item);
        continue;
      }

      const result = {
        report: artifacts.report,
        findings: artifacts.findings,
        sources: artifacts.sources,
      };

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
        },
        settings: { research: artifacts.meta?.settings ?? {} },
        engine,
      });

      item.status = 'imported';
      summary.imported += 1;
    } catch (error) {
      item.status = 'failed';
      item.reason = error?.message || String(error);
      summary.failed += 1;
    }

    summary.items.push(item);
  }

  return summary;
}
