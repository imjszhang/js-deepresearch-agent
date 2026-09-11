import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceStore, saveResearchArtifacts } from 'js-deepresearch-engine';
import { pinResult } from '../../scripts/benchmark/quality/load-result.mjs';
import { body } from '../../packages/js-deepresearch-engine/tests/helpers/canonical-llm.mjs';

export function programTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-program-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export function programArtifact(directory, revision = 'baseline', transform = r => r) {
  const store = new EvidenceStore();
  const version = store.register({ url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok' }, 'task');
  const passage = store.chunks(version.documentVersionId)[0];
  const result = transform({ resultRevision: revision, executionVersion: 2, report: '# Synthetic report\n\nAtlas provides a documented product [1.1].',
    findings: [], sources: [], evidenceStore: store.export(), evidenceAppendix: '# Evidence',
    citationRegistry: { schemaVersion: 1, entries: [{ citationKey: '1.1', sourceId: version.sourceId,
      documentVersionId: version.documentVersionId, passageIds: [passage.id], url: version.url }] } });
  saveResearchArtifacts({ sessionDir: directory, query: '调研 Atlas 产品', strategy: 'focused', settings: {}, result });
  return { pin: pinResult(directory), result, version, passage };
}
export function programCampaign(directory) {
  return { id: 'synthetic-contract', mode: 'live_google', schemaVersion: 1, protocolVersion: 'fixture', suiteHash: 'synthetic',
    protocol: { minTokens: 600000, maxTokens: 1000000, totalTokens: 1100000, judgeTokens: 100000, wallClockMs: 1800000, reportMaxOutputTokens: 16000 },
    runs: Array.from({ length: 4 }, (_, i) => ({ id: `run-${i}`, case: { id: `case-${i}`, query: '调研 Atlas 产品' },
      repeat: 1, status: 'research_complete', pin: programArtifact(path.join(directory, `input-${i}`), `input-${i}`).pin })) };
}
