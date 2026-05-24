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
  };

  fs.writeFileSync(artifacts.reportPath, result.report, 'utf8');
  fs.writeFileSync(artifacts.findingsPath, JSON.stringify(result.findings, null, 2), 'utf8');
  fs.writeFileSync(artifacts.sourcesPath, JSON.stringify(result.sources, null, 2), 'utf8');
  fs.writeFileSync(
    artifacts.metaPath,
    JSON.stringify(
      {
        query,
        strategy,
        researchId,
        createdAt: new Date().toISOString(),
        settings: {
          iterations: settings.research?.iterations,
          questionsPerIteration: settings.research?.questionsPerIteration,
          concurrency: settings.research?.concurrency,
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
