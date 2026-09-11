import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { benchmarkExecutionMode, validateCachedObservation } from '../scripts/benchmark-quality.mjs';
import { requireRebuildInputs, executeArtifactRebuilds, runArtifactRebuilds } from '../scripts/benchmark/quality/rebuild.mjs';
import { assessProgramExecutionGate, assessImprovementObservation, readProgramExecutionGate, readImprovementGate } from '../scripts/benchmark/quality/improvement-gate.mjs';
import { compareSummaries } from '../scripts/benchmark/quality/compare.mjs';
import { loadResult } from '../scripts/benchmark/quality/load-result.mjs';
import { programTemp, programCampaign, programArtifact } from './helpers/program-artifacts.mjs';
import { EVALUATION_SCHEMA_VERSION, JUDGE_VERSION, SCORING_VERSION } from '../scripts/benchmark/quality/schema.mjs';
import { canonicalLlm } from '../packages/js-deepresearch-engine/tests/helpers/canonical-llm.mjs';

// Module-boundary dependency for testing execution after authorization. Never a
// record on disk, nor a production certificate or a CLI bypass.
const authorization = { verifyProgram: () => ({ implementationIdentity: 'controlled-test-context', status: 'passed' }) };

test('[V17] complete saved bodies rebuild without baseline model scores using a scripted engine', async t => {
  const root = programTemp(t), campaign = programCampaign(root), directory = path.join(root, 'rebuilt');
  assert.ok(campaign.runs.every(r => !r.score));
  const prepared = requireRebuildInputs({ campaign, directory }, authorization);
  const calls = [], llm = canonicalLlm({ onCall: ({ purpose }) => calls.push(purpose) });
  llm.assessmentOrigin = 'scripted_fixture';
  const result = await executeArtifactRebuilds({ prepared, settings: { llm: {}, research: {} }, llm });
  assert.equal(result.status, 'finished'); assert.equal(result.origin, 'scripted_fixture');
  for (const run of result.runs) {
    const artifact = loadResult(run.pin);
    assert.equal(artifact.result.quality.budget.usage.searchRequests, 0);
    assert.equal(artifact.result.quality.budget.usage.sourceReads, 0);
    assert.equal(artifact.result.quality.budget.floorApplicable, false);
    assert.equal(artifact.result.benchmarkOrigin, 'scripted_fixture');
    assert.deepEqual(artifact.store.export().documentsByHash, loadResult(run.inputPin).store.export().documentsByHash);
  }
  assert.ok(calls.length > 0); assert.ok(!calls.includes('search_query_planning'));
  const count = calls.length;
  await executeArtifactRebuilds({ prepared, settings: { llm: {}, research: {} }, llm });
  assert.equal(calls.length, count);
});

test('[V17] invalid pins, output overlap, forged execution context and missing verification fail before calls', async t => {
  const root = programTemp(t), campaign = programCampaign(root);
  assert.throws(() => requireRebuildInputs({ campaign, directory: root }, authorization), /OVERLAPS/);
  const copy = globalThis.structuredClone(campaign); copy.runs[0].pin.manifestHash = 'wrong';
  assert.throws(() => requireRebuildInputs({ campaign: copy, directory: path.join(root, 'out') }, authorization), /Pinned/);
  await assert.rejects(executeArtifactRebuilds({ prepared: { campaign }, llm: { completeWithMetadata() { assert.fail(); } } }), /verified inputs/);
  await assert.rejects(runArtifactRebuilds({ campaign, directory: path.join(root, 'out'), programVerificationFile: path.join(root, 'missing'),
    llm: { completeWithMetadata() { assert.fail(); } } }), /PROGRAM_VERIFICATION/);
  const scripted = programArtifact(path.join(root, 'scripted-input'), 'scripted', r => ({ ...r, benchmarkOrigin: 'scripted_fixture' }));
  campaign.runs[0].pin = scripted.pin;
  assert.throws(() => requireRebuildInputs({ campaign, directory: path.join(root, 'out') }, authorization), /Scripted artifact/);
  assert.equal(assessProgramExecutionGate({ campaign, operation: 'rebuild' }, authorization).eligible, false);
});

test('[V18] cached fixture scores and mode drift cannot bypass the live observation gate', () => {
  const input = { gold: { goldHash: 'gold' }, artifact: { reportHash: 'report', pin: { resultRevision: 'r' } }, identity: {}, calibrationHash: null, mode: 'model-observation' };
  const score = { goldHash: 'gold', reportHash: 'report', resultPin: input.artifact.pin, judgeIdentity: {},
    judgeVersion: JUDGE_VERSION, schemaVersion: EVALUATION_SCHEMA_VERSION, scoringVersion: SCORING_VERSION,
    origin: 'model_assessment', modelAssessment: { origin: 'model_assessment' }, evaluationMode: input.mode };
  validateCachedObservation(score, input);
  for (const patch of [{ origin: 'scripted_fixture' }, { origin: undefined }, { evaluationMode: 'legacy-calibrated' },
    { judgments: { facts: [{ origin: 'scripted_fixture' }] } }]) assert.throws(() => validateCachedObservation({ ...score, ...patch }, input), /Cached score/);
});

test('[V18] program gate ignores model quality and cannot be satisfied by optimistic model output', t => {
  const root = programTemp(t), campaign = programCampaign(root);
  campaign.runs.forEach(r => { r.score = { qualityTargetMet: false, metrics: { pendingReview: true } }; });
  const input = { campaign, operation: 'score' };
  const passed = assessProgramExecutionGate(input, authorization);
  assert.equal(passed.eligible, true); assert.equal(passed.modelQualityAssessed, false); assert.equal('canLaunchLive' in passed, false);
  campaign.runs.forEach(r => { r.score.qualityTargetMet = true; });
  const failed = assessProgramExecutionGate(input, { verifyProgram() { throw Error('incomplete'); } });
  assert.equal(failed.eligible, false); assert.ok(failed.failures.includes('program_verification_invalid'));
  campaign.origin = 'scripted_fixture';
  assert.equal(assessProgramExecutionGate(input, authorization).eligible, false);
});

test('[V18] explicit modes and schema migration never downgrade old calibration gates', t => {
  const root = programTemp(t);
  assert.equal(benchmarkExecutionMode({ mode: 'model-observation', 'program-verification': 'record' }), 'model-observation');
  assert.equal(benchmarkExecutionMode({ calibration: 'old' }), 'legacy-calibrated');
  for (const flags of [{}, { 'program-verification': 'record' }, { mode: 'model-observation', calibration: 'old', 'program-verification': 'record' }]) assert.throws(() => benchmarkExecutionMode(flags));
  const file = path.join(root, 'gate.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
  assert.throws(() => readProgramExecutionGate(file), /SCHEMA_INVALID/);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, kind: 'benchmark_program_execution' }));
  assert.throws(() => readImprovementGate(file), /Legacy gate schema/);
});

function comparisonFixture() {
  const score = (pin, model) => ({ schemaVersion: 7, resultPin: pin, goldHash: 'rubric', judgeVersion: 'test-judge', judgeIdentity: { model },
    scoringVersion: 'formula-2', origin: 'model_assessment', extractionComplete: true,
    rows: [{ id: 'criterion', core: true, points: 1 }], metrics: { evidenceCoverage: 0.5, pendingReview: false } });
  const baseline = { mode: 'live_google', runs: ['a', 'b'].map((id, i) => { const pin = { resultRevision: id, manifestHash: id };
    return { id, caseId: id, repeat: 1, queryHash: 'query-' + id, pin, status: 'research_complete', score: score(pin, 'model-' + i) }; }) };
  return { baseline, candidate: globalThis.structuredClone(baseline) };
}
test('[V19] matching global model sets do not permit per-case identity swaps', () => {
  const { baseline, candidate } = comparisonFixture();
  [candidate.runs[0].score.judgeIdentity, candidate.runs[1].score.judgeIdentity] = [candidate.runs[1].score.judgeIdentity, candidate.runs[0].score.judgeIdentity];
  assert.throws(() => compareSummaries(baseline, candidate), /per-case/);
});
test('[V19] new rebuild revisions compare by baseline input and pending samples retain the denominator', () => {
  const { baseline, candidate } = comparisonFixture(); candidate.mode = 'artifact_rebuild';
  candidate.runs.forEach(r => { r.inputPin = r.pin; r.pin = { resultRevision: r.id + '-rebuilt', manifestHash: r.id + '-new' }; r.score.resultPin = r.pin; });
  candidate.runs[1].score.metrics.pendingReview = true;
  const rows = compareSummaries(baseline, candidate);
  assert.equal(rows[0].metrics.evidenceCoverage.difference, 0);
  assert.equal(rows[1].metrics.evidenceCoverage.candidate.n, 0);
  assert.equal(rows[1].metrics.evidenceCoverage.candidate.planned, 1);
  assert.equal(rows[1].metrics.evidenceCoverage.difference, null);
  const observation = assessImprovementObservation({ baseline, rebuilt: candidate });
  assert.equal(observation.status, 'incomplete'); assert.equal('eligible' in observation, false);
  candidate.runs[0].inputPin = { resultRevision: 'unrelated' };
  assert.throws(() => compareSummaries(baseline, candidate), /baseline revision/);
});

test('[V19] an observed first repetition cannot hide an unobserved second repetition', () => {
  const { baseline, candidate } = comparisonFixture();
  for (const summary of [baseline, candidate]) summary.runs.push(...summary.runs.map(r => ({ ...globalThis.structuredClone(r), id: r.id + '-2', repeat: 2 })));
  candidate.runs.filter(r => r.repeat === 2).forEach(r => { r.score.modelAssessment = { observed: false }; r.score.metrics.pendingReview = true; });
  const result = assessImprovementObservation({ baseline, rebuilt: candidate });
  assert.equal(result.status, 'incomplete'); assert.equal(result.plannedPairs, 4); assert.equal(result.observedPairs, 2);
  assert.equal(result.observedCases, 0); assert.equal(result.medianEvidenceCoverageDelta, null);
});
