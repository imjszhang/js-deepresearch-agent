import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_FILES = ['report.md', 'findings.json', 'sources.json', 'meta.json'];

export function loadArtifacts(workDir) {
  const resolvedDir = path.resolve(workDir);

  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`Work directory not found: ${resolvedDir}`);
  }

  const missing = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(resolvedDir, file)));
  if (missing.length > 0) {
    throw new Error(`Missing required artifact files: ${missing.join(', ')}`);
  }

  const meta = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'meta.json'), 'utf8'));
  const findings = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'findings.json'), 'utf8'));
  const sources = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'sources.json'), 'utf8'));
  const report = fs.readFileSync(path.join(resolvedDir, 'report.md'), 'utf8');

  return {
    workDir: resolvedDir,
    meta,
    findings,
    sources,
    report,
  };
}
