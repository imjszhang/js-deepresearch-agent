import fs from 'node:fs';
import { resolveResearchArtifacts, readArtifactEvidence } from 'js-deepresearch-engine';
import path from 'node:path';
import { loadArtifactsByResearchId as loadFromIntelStore } from '../../src/storage/intel-store.mjs';

const REQUIRED_FILES = ['report.md', 'findings.json', 'sources.json', 'meta.json'];
const OPTIONAL_JSON = ['brief', 'gaps', 'passages', 'claims', 'quality', 'trace'];

/**
 * Load benchmark artifacts by archived researchId (js-intel-store).
 * @param {string} researchId
 * @param {{ engine?: import('js-intel-store').StorageEngine }} [options]
 */
export function loadArtifactsByResearchId(researchId, options = {}) {
  return loadFromIntelStore(researchId, options);
}

function readJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  let raw;
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    raw = buffer.toString('utf16le');
  } else {
    raw = buffer.toString('utf8');
  }
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

export function loadArtifacts(workDir) {
  const resolvedDir = path.resolve(workDir);

  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`Work directory not found: ${resolvedDir}`);
  }

  const artifactPaths = resolveResearchArtifacts(resolvedDir);
  const readDir = artifactPaths.resultDir;
  const missing = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(readDir, file)));
  if (missing.length > 0) {
    throw new Error(`Missing required artifact files: ${missing.join(', ')}`);
  }

  const meta = readJsonFile(path.join(readDir, 'meta.json'));
  const findings = readJsonFile(path.join(readDir, 'findings.json'));
  const sources = readJsonFile(path.join(readDir, 'sources.json'));
  const report = fs.readFileSync(path.join(readDir, 'report.md'), 'utf8');
  const optional = Object.fromEntries(OPTIONAL_JSON.map((name) => {
    const file = path.join(readDir, `${name}.json`);
    const fallback = name === 'quality' || name === 'brief' ? null : [];
    return [name, fs.existsSync(file) ? readJsonFile(file) : fallback];
  }));

  const reportPlanFile = path.join(readDir, 'report-plan.json');
  const reportPlan = fs.existsSync(reportPlanFile) ? readJsonFile(reportPlanFile) : null;

  return {
    workDir: resolvedDir,
    artifactPaths,
    meta,
    findings,
    sources,
    report,
    reportPlan,
    canonicalResult: artifactPaths.schemaVersion === 2 ? readJsonFile(artifactPaths.resultPath) : null,
    evidenceAppendix: artifactPaths.evidencePath ? fs.readFileSync(artifactPaths.evidencePath, 'utf8') : null,
    citationRegistry: artifactPaths.citationsPath ? readJsonFile(artifactPaths.citationsPath) : null,
    evidenceStore: readArtifactEvidence(artifactPaths)?.export() || null,
    ...optional,
  };
}
