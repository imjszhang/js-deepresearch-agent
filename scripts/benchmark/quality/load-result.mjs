import fs from 'node:fs';
import path from 'node:path';
import { readArtifactManifest, readArtifactEvidence, resolveResearchArtifacts, parseCitations } from 'js-deepresearch-engine';
import { hash, readJson, invariant } from './schema.mjs';

export function pinResult(sessionDir) {
  const a = resolveResearchArtifacts(sessionDir);
  invariant(a.schemaVersion === 2 && a.manifestPath, 'Quality benchmark requires versioned v2 evidence');
  return { sessionDir: path.resolve(sessionDir), manifestPath: path.relative(sessionDir, a.manifestPath),
    manifestHash: hash(fs.readFileSync(a.manifestPath)), resultRevision: a.resultRevision };
}
export function loadResult(pin) {
  const a = readArtifactManifest(pin.sessionDir, pin.manifestPath);
  invariant(a.schemaVersion === 2 && a.resultRevision === pin.resultRevision
    && hash(fs.readFileSync(a.manifestPath)) === pin.manifestHash, 'Pinned revision mismatch');
  const store = readArtifactEvidence(a);
  const result = readJson(a.resultPath);
  const report = fs.readFileSync(a.reportPath, 'utf8');
  const registry = readJson(a.citationsPath);
  return { pin, report, reportHash: hash(report), store, registry, result };
}
export function citedEvidence(artifact) {
  const { report, registry, store } = artifact;
  const entries = Array.isArray(registry) ? registry : registry.entries || [];
  return parseCitations(report).map(key => {
    const entry = entries.find(e => e.citationKey === key || e.key === key);
    if (!entry) return { key, resolved: false, passages: [] };
    const ids = entry.passageIds || (entry.passageId ? [entry.passageId] : []);
    const passages = ids.map(id => store.passages.get(id)).filter(Boolean).map(p => ({ id: p.id,
      documentVersionId: p.documentVersionId, startChar: p.startChar, endChar: p.endChar, text: p.text,
      url: store.versions.get(p.documentVersionId)?.url }));
    return { key, resolved: ids.length > 0 && passages.length === ids.length, passages };
  });
}
