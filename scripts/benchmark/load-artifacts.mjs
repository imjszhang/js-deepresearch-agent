import fs from 'node:fs';
import path from 'node:path';
import { loadArtifactsByResearchId as loadFromIntelStore } from '../../src/storage/intel-store.mjs';

const REQUIRED_FILES = ['report.md', 'findings.json', 'sources.json', 'meta.json'];
const OPTIONAL_JSON = ['gaps', 'passages', 'claims', 'quality', 'trace'];

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

  const missing = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(resolvedDir, file)));
  if (missing.length > 0) {
    throw new Error(`Missing required artifact files: ${missing.join(', ')}`);
  }

  const meta = readJsonFile(path.join(resolvedDir, 'meta.json'));
  const findings = readJsonFile(path.join(resolvedDir, 'findings.json'));
  const sources = readJsonFile(path.join(resolvedDir, 'sources.json'));
  const report = fs.readFileSync(path.join(resolvedDir, 'report.md'), 'utf8');
  const optional = Object.fromEntries(OPTIONAL_JSON.map((name) => {
    const file = path.join(resolvedDir, `${name}.json`);
    return [name, fs.existsSync(file) ? readJsonFile(file) : (name === 'quality' ? null : [])];
  }));

  return {
    workDir: resolvedDir,
    meta,
    findings,
    sources,
    report,
    ...optional,
  };
}
