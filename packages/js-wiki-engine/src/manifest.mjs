import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;

export function manifestPath(vaultDir) {
  return path.join(vaultDir, 'manifest.json');
}

export function loadManifest(vaultDir) {
  const file = manifestPath(vaultDir);
  if (!fs.existsSync(file)) {
    return createEmptyManifest();
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveManifest(vaultDir, manifest) {
  const file = manifestPath(vaultDir);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
}

export function createEmptyManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    vaultVersion: MANIFEST_VERSION,
    compiledAt: null,
    sources: {},
    topics: {},
    pages: {},
  };
}

export function shouldRecompileSource(manifest, sourceId, hash) {
  const existing = manifest.sources?.[sourceId];
  if (!existing) return true;
  return existing.hash !== hash;
}

export function recordSourceCompile(manifest, source, hash, pages) {
  manifest.sources[source.id] = {
    hash,
    pages: [...pages],
    researchId: source.researchId,
    updatedAt: new Date().toISOString(),
  };
}

export function recordTopicCompile(manifest, topicTitle, pages) {
  manifest.topics[topicTitle] = {
    pages: [...pages],
    updatedAt: new Date().toISOString(),
  };
}
