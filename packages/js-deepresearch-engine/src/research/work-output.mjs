import fs from 'node:fs';
import path from 'node:path';

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
  const sessionDir = path.join(workDir, strategy, formatSessionTimestamp(date));
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
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
    gapsPath: path.join(sessionDir, 'gaps.json'),
    passagesPath: path.join(sessionDir, 'passages.json'),
    claimsPath: path.join(sessionDir, 'claims.json'),
    qualityPath: path.join(sessionDir, 'quality.json'),
    tracePath: path.join(sessionDir, 'trace.json'),
  };

  fs.writeFileSync(artifacts.reportPath, result.report, 'utf8');
  fs.writeFileSync(artifacts.findingsPath, JSON.stringify(result.findings, null, 2), 'utf8');
  fs.writeFileSync(artifacts.sourcesPath, JSON.stringify(result.sources, null, 2), 'utf8');
  fs.writeFileSync(artifacts.gapsPath, JSON.stringify(result.gaps || [], null, 2), 'utf8');
  fs.writeFileSync(artifacts.passagesPath, JSON.stringify(result.passages || [], null, 2), 'utf8');
  fs.writeFileSync(artifacts.claimsPath, JSON.stringify(result.claims || [], null, 2), 'utf8');
  fs.writeFileSync(artifacts.qualityPath, JSON.stringify(result.quality || { schemaVersion: 3, gate: 'pass', flags: [] }, null, 2), 'utf8');
  fs.writeFileSync(artifacts.tracePath, JSON.stringify(result.trace || [], null, 2), 'utf8');
  fs.writeFileSync(
    artifacts.metaPath,
    JSON.stringify(
      {
        query,
        strategy,
        researchId,
        artifactSchemaVersion: 3,
        createdAt: new Date().toISOString(),
        artifacts: {
          gapsPath: artifacts.gapsPath,
          passagesPath: artifacts.passagesPath,
          claimsPath: artifacts.claimsPath,
          qualityPath: artifacts.qualityPath,
          tracePath: artifacts.tracePath,
        },
        settings: {
          iterations: settings.research?.iterations,
          questionsPerIteration: settings.research?.questionsPerIteration,
          concurrency: settings.research?.concurrency,
          budget: settings.research?.budget,
        },
      },
      null,
      2,
    ),
    'utf8',
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
