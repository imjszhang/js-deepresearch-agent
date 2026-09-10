import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildFromEvidence } from '../src/research/artifact-rebuild.mjs';
import { EvidenceStore } from '../src/research/evidence-store.mjs';
import { FileRunRecorder } from '../src/research/run-recorder.mjs';
import { canonicalLlm, body } from './helpers/canonical-llm.mjs';
import { saveResearchArtifacts } from '../src/research/work-output.mjs';
import { resolveResearchArtifacts, readArtifactEvidence } from '../src/research/result-artifacts.mjs';

test('fixed-body rebuild cannot search, preserves bodies and completed resume makes no calls', async t => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-artifact-rebuild-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 const store = new EvidenceStore();
 const version = store.register({ url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok' }, 'old-task');
 const p = store.chunks(version.documentVersionId)[0];
 store.recordInspection({ taskId: 'old-task', documentVersionId: version.documentVersionId, passageIds: [p.id], verdict: 'supported' });
 const snapshot = store.export(), settings = { llm: {}, research: {} }, calls = [];
 const args = { query: '调研 Atlas 产品', evidenceStore: snapshot, inputPin: { resultRevision: 'old' }, settings,
 llm: canonicalLlm({ onCall: ({ purpose }) => calls.push(purpose) }), recorder: new FileRunRecorder({ sessionDir: directory, strategy: 'artifact_rebuild', query: '调研 Atlas 产品' }) };
 const result = await rebuildFromEvidence(args);
 assert.equal(result.researchMode, 'artifact_rebuild');
 assert.equal(result.quality.budget.usage.searchRequests, 0);
 assert.equal(result.quality.budget.usage.sourceReads, 0);
 assert.equal(result.quality.budget.floorApplicable, false);
 assert.equal(result.quality.budget.floorStatus, 'unknown');
 assert.ok(!calls.includes('search_query_planning'));
 assert.ok(result.evidenceStore.inspections.every(i => i.taskId !== 'old-task'));
 assert.deepEqual(result.evidenceStore.documentsByHash, snapshot.documentsByHash);
 saveResearchArtifacts({ sessionDir: directory, query: args.query, strategy: 'artifact_rebuild', settings, result });
 const loaded = readArtifactEvidence(resolveResearchArtifacts(directory));
 assert.deepEqual(loaded.export(), new EvidenceStore(result.evidenceStore).export());
 const again = await rebuildFromEvidence({ ...args, recorder: FileRunRecorder.reopen(directory),
 llm: { completeWithMetadata() { assert.fail('completed rebuild must be immutable'); } } });
 assert.equal(again.resultRevision, result.resultRevision);
 await assert.rejects(rebuildFromEvidence({ ...args, query: 'changed' }), /INPUT_CHANGED/);
});
