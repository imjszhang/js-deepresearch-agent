import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EvidenceStore } from './evidence-store.mjs';

const FILES = {
  reportPath: 'report.md', findingsPath: 'findings.json', sourcesPath: 'sources.json',
  metaPath: 'meta.json', briefPath: 'brief.json', gapsPath: 'gaps.json',
  passagesPath: 'passages.json', claimsPath: 'claims.json', qualityPath: 'quality.json',
  tracePath: 'trace.json', reportPlanPath: 'report-plan.json', resultPath: 'result.json',
};
const EVIDENCE_FILES = { evidenceIndexPath: 'evidence-index.json', citationsPath: 'citations.json', evidencePath: 'evidence.md' };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function atomicWriteResultFile(file, content) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
}

export function artifactPaths(sessionDir, revision = null, schemaVersion = 1) {
  if (revision && !/^[a-zA-Z0-9_-]+$/.test(revision)) throw new Error('Invalid result revision');
  sessionDir = path.resolve(sessionDir);
  const resultDir = revision ? path.join(sessionDir, 'results', revision) : sessionDir;
  return {
    sessionDir, resultDir, resultRevision: revision,
    schemaVersion,
    manifestPath: revision ? path.join(resultDir, 'manifest.json') : null,
    ...Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.join(resultDir, file)])),
    ...(schemaVersion === 2 ? Object.fromEntries(Object.entries(EVIDENCE_FILES).map(([key, file]) => [key, path.join(resultDir, file)])) : {}),
  };
}

export function finishArtifactRevision(artifacts) {
  const extra = artifacts.schemaVersion === 2 ? Object.values(EVIDENCE_FILES) : [];
  if (artifacts.schemaVersion === 2) {
    const index = JSON.parse(fs.readFileSync(artifacts.evidenceIndexPath, 'utf8'));
    extra.push(...new Set(index.versions.map((version) => version.bodyRef)));
  }
  const files = Object.fromEntries([...Object.values(FILES), ...extra].map((file) => [file, hash(fs.readFileSync(path.join(artifacts.resultDir, file)))]));
  atomicWriteResultFile(artifacts.manifestPath, JSON.stringify({ schemaVersion: artifacts.schemaVersion || 1, resultRevision: artifacts.resultRevision, files }));
}

export function readArtifactManifest(sessionDir, manifestPath) {
  const root = fs.realpathSync(sessionDir);
  const manifestFile = fs.realpathSync(path.resolve(sessionDir, manifestPath));
  if (!manifestFile.startsWith(`${root}${path.sep}`)) throw new Error('Artifact manifest escapes session');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (![1, 2].includes(manifest.schemaVersion) || !manifest.resultRevision) throw new Error('Invalid artifact manifest');
  const artifacts = artifactPaths(root, manifest.resultRevision, manifest.schemaVersion);
  if (fs.realpathSync(artifacts.manifestPath) !== manifestFile) throw new Error('Artifact revision mismatch');
  const required = [...Object.values(FILES), ...(manifest.schemaVersion === 2 ? Object.values(EVIDENCE_FILES) : [])];
  if (required.some((file) => !manifest.files?.[file])) throw new Error('Artifact required file is missing');
  const checked = manifest.schemaVersion === 2 ? Object.keys(manifest.files) : Object.values(FILES);
  for (const file of checked) {
    if (!required.includes(file) && !/^evidence-bodies\/[a-f0-9]{64}\.txt$/.test(file)) throw new Error('Invalid artifact evidence path');
    const target = fs.realpathSync(path.join(artifacts.resultDir, file));
    if (!target.startsWith(`${fs.realpathSync(artifacts.resultDir)}${path.sep}`)
      || hash(fs.readFileSync(target)) !== manifest.files?.[file]) {
      throw new Error(`Artifact integrity check failed: ${file}`);
    }
  }
  if (manifest.schemaVersion === 2) {
    const index = JSON.parse(fs.readFileSync(artifacts.evidenceIndexPath, 'utf8'));
    if (index.versions.some((version) => !manifest.files[version.bodyRef])) throw new Error('Evidence body missing from manifest');
    const store = readArtifactEvidence(artifacts);
    const registry = JSON.parse(fs.readFileSync(artifacts.citationsPath, 'utf8'));
    if (registry.schemaVersion !== 1) throw new Error('Unsupported citation registry');
    const keys = new Set();
    for (const entry of registry.entries) {
      if (keys.has(entry.citationKey) || !/^\d+\.\d+$/.test(entry.citationKey)
        || !store.versions.has(entry.documentVersionId) || store.versions.get(entry.documentVersionId).sourceId !== entry.sourceId
        || !Array.isArray(entry.passageIds) || !entry.passageIds.length
        || entry.passageIds.some((key) => store.passages.get(key)?.documentVersionId !== entry.documentVersionId)) throw new Error('Citation registry integrity failed');
      keys.add(entry.citationKey);
    }
    const result = JSON.parse(fs.readFileSync(artifacts.resultPath, 'utf8'));
    if ((result.reportPlan?.claimGraphVersion || 1) > 2 || (result.reportPlan?.claimReviewVersion || 1) > 4) throw new Error('Unsupported claim validation protocol');
    if (JSON.stringify(result.citationRegistry) !== JSON.stringify(registry)
      || JSON.stringify(new EvidenceStore(result.evidenceStore).export()) !== JSON.stringify(store.export())) throw new Error('Canonical result evidence mismatch');
  }
  return artifacts;
}

export function readArtifactEvidence(artifacts) {
  if (artifacts.schemaVersion !== 2) return null;
  const index = JSON.parse(fs.readFileSync(artifacts.evidenceIndexPath, 'utf8'));
  const documentsByHash = {};
  for (const version of index.versions || []) {
    if (version.bodyRef !== `evidence-bodies/${version.bodyHash}.txt` || !/^[a-f0-9]{64}$/.test(version.bodyHash)) throw new Error('Invalid evidence body path');
    const file = fs.realpathSync(path.join(artifacts.resultDir, version.bodyRef));
    if (!file.startsWith(`${fs.realpathSync(artifacts.resultDir)}${path.sep}`)) throw new Error('Evidence path escapes result');
    documentsByHash[version.bodyHash] = fs.readFileSync(file, 'utf8');
  }
  return new EvidenceStore({ ...index, documentsByHash });
}

export function resolveResearchArtifacts(sessionDir) {
  const pointer = path.join(sessionDir, 'result-current.json');
  if (!fs.existsSync(pointer)) return artifactPaths(sessionDir);
  const current = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (current.schemaVersion !== 1 || typeof current.manifest !== 'string') throw new Error('Invalid result pointer');
  return readArtifactManifest(sessionDir, current.manifest);
}

export function publishResearchArtifacts(artifacts) {
  if (!artifacts?.manifestPath) return;
  readArtifactManifest(artifacts.sessionDir, artifacts.manifestPath);
  atomicWriteResultFile(path.join(artifacts.sessionDir, 'result-current.json'), JSON.stringify({
    schemaVersion: 1,
    manifest: path.relative(artifacts.sessionDir, artifacts.manifestPath),
  }));
}

// Compatibility exports are not the authority for versioned sessions.
export function writeLegacyArtifactCopies(artifacts) {
  if (!artifacts?.manifestPath) return;
  for (const [key, file] of Object.entries(FILES)) {
    if (key === 'resultPath') continue;
    atomicWriteResultFile(path.join(artifacts.sessionDir, file), fs.readFileSync(artifacts[key]));
  }
}
