import test from 'node:test';
import assert from 'node:assert/strict';
import { assessImprovementGate } from '../scripts/benchmark/quality/improvement-gate.mjs';
import { requireScoredBaseline } from '../scripts/benchmark/quality/rebuild.mjs';
import { hash, JUDGE_VERSION, SCORING_VERSION } from '../scripts/benchmark/quality/schema.mjs';
import { JsEyesCliSearchEngine } from '../src/search-providers/js-eyes/index.mjs';

function fixtures() {
 const calibration = { machineCalibrationPassed: true, judgeVersion: JUDGE_VERSION };
 const score = evidenceCoverage => ({ extractionComplete: true, judgeVersion: JUDGE_VERSION, scoringVersion: SCORING_VERSION,
  calibrationHash: hash(calibration), goldHash: 'gold', judgeIdentity: {}, researchMode: 'artifact_rebuild',
  metrics: { evidenceCoverage, majorErrorCount: 0, pendingReview: false }, majorErrors: [],
  rows: [{ id: 'core', core: true, points: 1 }] });
 const baseline = { runs: Array.from({ length: 4 }, (_, i) => ({ id: 'r' + i, repeat: 1, status: 'research_complete',
  pin: { resultRevision: 'old-' + i }, queryHash: 'q' + i, score: score(0.5) })) };
 const rebuilt = { runs: baseline.runs.map(r => ({ ...r, inputPin: r.pin, pin: { resultRevision: 'new-' + r.id }, score: score(0.65) })) };
 return { calibration, baseline, rebuilt, regressionPassed: true };
}
test('live gate requires calibration, complete compatible scores, 10pp gain and no core regressions', () => {
 const x = fixtures();
 assert.equal(assessImprovementGate(x).canLaunchLive, false);
 assert.deepEqual(assessImprovementGate(x).failures, ['calibration_not_passed']);
 x.regressionPassed = false;
 assert.equal(assessImprovementGate(x).canLaunchLive, false);
 x.regressionPassed = true;
 x.rebuilt.runs[0].score.rows[0].points = 0;
 assert.ok(assessImprovementGate(x).failures.includes('correct_core_regressed'));
 x.rebuilt.runs[0].score.metrics.pendingReview = true;
 assert.ok(assessImprovementGate(x).failures.includes('comparison_score_pending'));
 assert.throws(() => requireScoredBaseline(x.baseline, '/does-not-exist', { machineCalibrationPassed: false }), /Calibration gate/);
});
test('a failing skill stops after its threshold while another healthy skill keeps responding', async () => {
 const engine = new JsEyesCliSearchEngine({ jsEyesSkills: ['js-google-ops-skill', 'js-reddit-ops-skill'], jsEyesMaxRetries: 0 });
 const calls = { google: 0, reddit: 0 };
 engine.runCliQueued = async (_, __, args) => {
  if (args.includes('js-google-ops-skill')) { calls.google++; throw Object.assign(new Error('structured failure'), { code: 'connection_closed' }); }
  calls.reddit++; return { ok: true, result: { items: [] } };
 };
 for (let i = 0; i < 5; i++) assert.deepEqual(await engine.search('fixture ' + i), []);
 assert.equal(calls.google, 3); assert.ok(calls.reddit >= 5);
 const saved = engine.getSearchHealthState();
 assert.equal(saved.find(([skill]) => skill === 'js-google-ops-skill')[1].state, 'open');
 const restored = new JsEyesCliSearchEngine(); restored.restoreSearchHealthState(saved);
 assert.equal(restored.getSearchHealthState()[0][1].state, 'open');
 restored.beginReadinessProbe();
 assert.equal(restored.getSearchHealthState()[0][1].state, 'half_open');
});
