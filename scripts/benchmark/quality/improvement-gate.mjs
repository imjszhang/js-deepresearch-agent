import path from 'node:path';
import { hash, invariant, readJson, JUDGE_VERSION, SCORING_VERSION } from './schema.mjs';
import { summarizeCampaign } from './compare.mjs';
import { treeHash } from './campaign.mjs';
function median(values) {
 const v = values.slice().sort((a, b) => a - b);
 return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2;
}

// Content comparison has its own gate; it makes no live-search or efficiency
// claim and cannot erase failures from either campaign.
export function assessImprovementGate({ baseline, rebuilt, calibration, regressionPassed = false }) {
 const failures = [];
 if (!regressionPassed) failures.push('regression_not_verified');
 if (!calibration?.machineCalibrationPassed || calibration.judgeVersion !== JUDGE_VERSION) failures.push('calibration_not_passed');
 const rows = [];
 const first = baseline.runs.filter(r => r.repeat === 1);
 if (first.length !== 4) failures.push('first_four_cases_missing');
 for (const run of baseline.runs.filter(r => r.status === 'research_complete')) {
   if (!run.score || run.score.metrics.pendingReview || !run.score.extractionComplete) failures.push('baseline_score_pending');
 }
 for (const original of first) {
   const candidate = rebuilt.runs.find(r => r.id === original.id);
   const a = original.score, b = candidate?.score;
   if (hash(original.pin) !== hash(candidate?.inputPin) || original.queryHash !== candidate?.queryHash) failures.push('rebuild_input_mismatch');
   if (!a || !b || ![a, b].every(s => s.extractionComplete && !s.metrics.pendingReview)) { failures.push('comparison_score_pending'); continue; }
   const version = s => hash([s.goldHash, s.judgeVersion, s.judgeIdentity, s.scoringVersion, s.calibrationHash]);
   if (version(a) !== version(b) || b.judgeVersion !== JUDGE_VERSION || b.scoringVersion !== SCORING_VERSION
     || b.calibrationHash !== hash(calibration) || b.researchMode !== 'artifact_rebuild') { failures.push('comparison_identity_mismatch'); continue; }
   invariant(a.rows.every(r => b.rows.some(other => other.id === r.id)), 'Criterion denominator changed');
   const regressions = a.rows.filter(r => r.core && r.points === 1 && b.rows.find(other => other.id === r.id)?.points !== 1).map(r => r.id);
   if (regressions.length) failures.push('correct_core_regressed');
   const addedMajor = b.majorErrors?.length > 0 && b.metrics.majorErrorCount > a.metrics.majorErrorCount;
   // Different statements cannot be equated by count: any candidate major error
   // needs independent review before asserting that no new error was introduced.
   if (addedMajor || b.metrics.majorErrorCount > 0) failures.push('candidate_major_error');
   const delta = b.metrics.evidenceCoverage - a.metrics.evidenceCoverage;
   if (!Number.isFinite(a.metrics.evidenceCoverage) || !Number.isFinite(b.metrics.evidenceCoverage)) failures.push('coverage_unavailable');
   rows.push({ id: original.id, before: a.metrics.evidenceCoverage, after: b.metrics.evidenceCoverage, delta, coreRegressions: regressions });
 }
 const medianDelta = rows.length === 4 ? median(rows.map(r => r.delta)) : null;
 if (medianDelta == null || medianDelta < 0.1 - 1e-10) failures.push('coverage_gain_below_10pp');
 return { canLaunchLive: failures.length === 0, failures: [...new Set(failures)], medianEvidenceCoverageDelta: medianDelta, rows,
   humanReviewed: false, interpretation: 'Fixed-body delivery diagnostic only; no search or total-cost causal conclusion.' };
}

export function readImprovementGate(configFile) {
 const config = readJson(configFile);
 const resolve = key => path.resolve(path.dirname(configFile), config[key]);
 const baselineFile = resolve('baselineCampaign'), rebuiltFile = resolve('rebuiltCampaign');
 const checks = readJson(resolve('regressionChecks'));
 const regressionPassed = checks.test === 'passed' && checks.lint === 'passed' && checks.build === 'passed'
   && checks.runtimeHash === hash(['src', 'packages/js-deepresearch-engine/src'].map(treeHash));
 return assessImprovementGate({ baseline: summarizeCampaign(readJson(baselineFile), path.dirname(baselineFile), { evaluationDirectory: resolve('baselineEvaluationDirectory') }),
   rebuilt: summarizeCampaign(readJson(rebuiltFile), path.dirname(rebuiltFile), { evaluationDirectory: resolve('rebuiltEvaluationDirectory') }),
   calibration: readJson(resolve('calibration')), regressionPassed });
}
