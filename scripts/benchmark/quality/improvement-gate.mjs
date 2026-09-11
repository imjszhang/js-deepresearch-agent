import path from 'node:path';
import { hash, invariant, readJson, JUDGE_VERSION, SCORING_VERSION } from './schema.mjs';
import { summarizeCampaign, compareSummaries } from './compare.mjs';
import { treeHash } from './campaign.mjs';
import { requireCalibration } from './calibration-suite.mjs';
import { requireProgramVerification } from './program-verification.mjs';
import { verifyArtifact, assertIsolatedOutput } from './artifact-verification.mjs';
function median(values) {
 const v = values.slice().sort((a, b) => a - b);
 return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2;
}

// Content comparison has its own gate; it makes no live-search or efficiency
// claim and cannot erase failures from either campaign.
export function assessImprovementGate({ baseline, rebuilt, calibration, regressionPassed = false }) {
 const failures = [];
 if (!regressionPassed) failures.push('regression_not_verified');
 try { requireCalibration(calibration); } catch { failures.push('calibration_not_passed'); }
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
 invariant(config.schemaVersion == null || config.schemaVersion === 1, 'Legacy gate schema mismatch; use program-execution-gate for new gates');
 const resolve = key => path.resolve(path.dirname(configFile), config[key]);
 const baselineFile = resolve('baselineCampaign'), rebuiltFile = resolve('rebuiltCampaign');
 const checks = readJson(resolve('regressionChecks'));
 const regressionPassed = checks.test === 'passed' && checks.lint === 'passed' && checks.build === 'passed'
   && checks.runtimeHash === hash(['src', 'packages/js-deepresearch-engine/src'].map(treeHash));
 return assessImprovementGate({ baseline: summarizeCampaign(readJson(baselineFile), path.dirname(baselineFile), { evaluationDirectory: resolve('baselineEvaluationDirectory') }),
   rebuilt: summarizeCampaign(readJson(rebuiltFile), path.dirname(rebuiltFile), { evaluationDirectory: resolve('rebuiltEvaluationDirectory') }),
   calibration: readJson(resolve('calibration')), regressionPassed });
}

export const PROGRAM_EXECUTION_GATE_VERSION = 2;

// Verification is injected only at the module boundary for offline contract tests.
// The CLI always uses the real record validator. There is no skip-gate CLI flag.
export function assessProgramExecutionGate({ programVerificationFile, campaign, operation, outputDir },
 { verifyProgram = requireProgramVerification } = {}) {
 const failures = [], checks = {};
 let verification = null;
 try { verification = verifyProgram(programVerificationFile); checks.programVerification = true; }
 catch { checks.programVerification = false; failures.push('program_verification_invalid'); }
 checks.operation = ['run', 'score', 'rebuild'].includes(operation);
 if (!checks.operation) failures.push('operation_invalid');
 checks.campaign = Array.isArray(campaign?.runs) && campaign.runs.length > 0
   && new Set(campaign.runs.map(r => r.id)).size === campaign.runs.length;
 if (!checks.campaign) failures.push('campaign_invalid');
 checks.observationOrigin = campaign?.origin !== 'scripted_fixture';
 if (!checks.observationOrigin) failures.push('scripted_fixture_is_not_live_input');
 const protocol = campaign?.protocol;
 const positive = n => Number.isFinite(n) && n > 0;
 checks.budget = operation === 'score' ? positive(protocol?.judgeTokens)
   : operation === 'rebuild' ? positive(protocol?.reportMaxOutputTokens)
   : positive(protocol?.wallClockMs) && protocol?.minTokens === 600000 && protocol?.maxTokens === 1000000
     && protocol?.totalTokens >= protocol?.maxTokens && positive(protocol?.reportMaxOutputTokens);
 if (!checks.budget) failures.push('budget_contract_invalid');
 const selected = (campaign?.runs || []).filter(r => operation === 'rebuild' ? r.repeat === 1 : r.status === 'research_complete');
 if (operation !== 'run') {
   checks.inputs = selected.length > 0 && (operation !== 'rebuild' || selected.length === 4)
     && selected.every(r => r.status === 'research_complete' && r.pin);
   if (checks.inputs) try { for (const run of selected) invariant(verifyArtifact(run.pin).inputOrigin !== 'scripted_fixture', 'Scripted artifact is not a live input'); } catch { checks.inputs = false; }
   if (!checks.inputs) failures.push('input_artifact_invalid');
 }
 if (outputDir) {
   try { assertIsolatedOutput(outputDir, (campaign?.runs || []).map(r => r.pin?.sessionDir)); checks.outputIsolation = true; }
   catch { checks.outputIsolation = false; failures.push('output_overlaps_input'); }
 }
 return { schemaVersion: PROGRAM_EXECUTION_GATE_VERSION, origin: 'program_check', operation,
   eligible: failures.length === 0, checks, failures,
   implementationIdentity: verification?.implementationIdentity || null,
   scope: 'program_and_static_experiment_inputs',
   runtimePreflightRequired: operation === 'run', modelQualityAssessed: false };
}

export function readProgramExecutionGate(configFile, { expectedCampaignFile } = {}) {
 const config = readJson(configFile), base = path.dirname(path.resolve(configFile));
 invariant(config.schemaVersion === PROGRAM_EXECUTION_GATE_VERSION && config.kind === 'benchmark_program_execution', 'PROGRAM_GATE_SCHEMA_INVALID');
 invariant(config.programVerification && config.campaign && !config.calibration && !config.regressionChecks, 'PROGRAM_GATE_CONFIG_INVALID');
 const campaignFile = path.resolve(base, config.campaign);
 if (expectedCampaignFile) invariant(campaignFile === path.resolve(expectedCampaignFile), 'PROGRAM_GATE_CAMPAIGN_MISMATCH');
 return assessProgramExecutionGate({ programVerificationFile: path.resolve(base, config.programVerification),
   campaign: readJson(campaignFile), operation: config.operation, outputDir: config.outputDir ? path.resolve(base, config.outputDir) : undefined });
}

export function assessImprovementObservation({ baseline, rebuilt }) {
 const cases = compareSummaries(baseline, rebuilt);
 const observed = cases.map(c => c.metrics.evidenceCoverage.difference).filter(Number.isFinite);
 const pairs = cases.flatMap(c => c.pairs), completeCases = cases.filter(c => c.pairs.length && c.pairs.every(p => p.status === 'observed')
   && Number.isFinite(c.metrics.evidenceCoverage.difference)).length;
 const complete = cases.length > 0 && completeCases === cases.length;
 const origin = cases.some(c => c.origin.includes('scripted_fixture')) ? 'scripted_fixture' : 'model_assessment';
 return { schemaVersion: 1, origin, status: complete ? 'observed' : 'incomplete',
   medianEvidenceCoverageDelta: complete ? median(observed) : null,
   plannedCases: cases.length, observedCases: completeCases, plannedPairs: pairs.length,
   observedPairs: pairs.filter(p => p.status === 'observed').length, cases,
   interpretation: 'Descriptive model observations only; no engineering pass or experiment launch decision.' };
}
