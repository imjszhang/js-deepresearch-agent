import { calibrationBudgetPlan } from './calibration-budget.mjs';
import { BOUNDARY_STAGE, runBoundaryDiagnostics, checkBoundaryDiagnostics } from './boundary-diagnostics.mjs';
import { freezeVerification } from './calibration-freeze.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireSessionLock } from '../../../src/session-lock.mjs';
import { hash, readJson, writeJson, invariant, JUDGE_VERSION, SCORING_VERSION, EVALUATION_SCHEMA_VERSION, CALIBRATION_SCHEMA_VERSION } from './schema.mjs';
import { Judge } from './judge.mjs';
import { evaluate, verifyFacts } from './evaluate.mjs';
import { extractReportFacts } from './report-facts.mjs';
import { checkOracle } from './calibration-oracle.mjs';
import { loadCalibrationSuite, evaluatorCodeIdentity, buildCalibrationArtifact, calibrationQualification, checkCalibrationPairs, reportKey } from './calibration-suite.mjs';

export async function calibrate({ llm, identity, directory, suiteFile, planFile, validationFile,
  registryDirectory = 'work_dir/quality-calibration-registry' }) {
  invariant(suiteFile, 'calibrate requires a versioned suite; legacy holdout-file cannot certify this judge');
  const suite = loadCalibrationSuite(suiteFile);
  directory = path.resolve(directory); registryDirectory = path.resolve(registryDirectory);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(registryDirectory, { recursive: true });
  // Shared registry lock prevents two output directories spending the same round.
  const releaseRegistry = acquireSessionLock(registryDirectory);
  let release, activeSummary;
  try {
    release = acquireSessionLock(directory);
    const codeIdentity = evaluatorCodeIdentity();
    const verification = freezeVerification(planFile, validationFile, codeIdentity);
    const budgetPlan = calibrationBudgetPlan(suite); invariant(budgetPlan.knownRequestsAdmissible, 'Calibration known requests exceed stage budget');
    const freeze = { ...verification, budgetPlan, suiteHash: suite.suiteHash, suiteFile: suite.suiteFile, directory, codeIdentity, identity,
      judgeVersion: JUDGE_VERSION, scoringVersion: SCORING_VERSION, evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
      baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    const freezeFile = path.join(directory, 'freeze.json');
    const registryFile = path.join(registryDirectory, 'registry.json');
    const registry = fs.existsSync(registryFile) ? readJson(registryFile) : { schemaVersion: 1, rounds: {}, exposures: [] };
    freeze.priorExposureRegistryHash = fs.existsSync(freezeFile) ? readJson(freezeFile).priorExposureRegistryHash : hash(registry);
    const freezeHash = hash(freeze);
    if (fs.existsSync(freezeFile)) invariant(hash(readJson(freezeFile)) === freezeHash, 'Calibration inputs changed; frozen round cannot be retuned');
    const existing = registry.rounds[suite.roundId];
    invariant(!existing || existing.freezeHash === freezeHash && existing.directory === directory, 'Calibration round already bound; new directory cannot reset budget');
    const known = new Set(registry.exposures.filter(e => e.roundId !== suite.roundId).map(e => e.reportHash));
    invariant(suite.stages.slice(1).every(s => s.cases.every(c => !known.has(reportKey(c.report)))), 'Holdout exposed in a prior real round');
    registry.rounds[suite.roundId] ||= { freezeHash, directory, startedAt: new Date().toISOString(), stages: {} };
    writeJson(registryFile, registry); writeJson(freezeFile, freeze);
    const stageCaps = Object.fromEntries(suite.stages.map(s => [s.id, { tokens: s.tokens, wallClockMs: s.wallClockMs }]));
    stageCaps[BOUNDARY_STAGE.id] = { tokens: BOUNDARY_STAGE.tokens, wallClockMs: BOUNDARY_STAGE.wallClockMs };
    const judge = new Judge({ llm, identity, directory: path.join(directory, 'judge'), limit: suite.totalTokens,
      wallClockMs: suite.wallClockMs, timeoutMs: suite.timeoutMs, stages: stageCaps, beforeDispatch: () => {
        invariant(evaluatorCodeIdentity() === freeze.codeIdentity && hash(fs.readFileSync(planFile)) === freeze.planHash
          && loadCalibrationSuite(suiteFile).suiteHash === suite.suiteHash, 'CALIBRATION_INPUTS_CHANGED');
      } });
    const previousFile = path.join(directory, 'calibration.json');
    const previous = fs.existsSync(previousFile) ? readJson(previousFile) : null;
    if (previous && ['stopped', 'finished'].includes(previous.status)) {
      invariant(previous.freezeHash === freezeHash && hash(previous.usage) === hash(judge.usage()), 'Calibration terminal ledger changed');
      return previous;
    }
    const summary = { relationDecisionVersion: verification.relationDecisionVersion, bindingReviewVersion: verification.bindingReviewVersion, relationReviewVersion: verification.relationReviewVersion, relationAuditVersion: verification.relationAuditVersion, requestBudgetVersion: verification.requestBudgetVersion, locatorVersion: verification.locatorVersion, executionMetricsVersion: verification.executionMetricsVersion, schemaVersion: CALIBRATION_SCHEMA_VERSION, judgeVersion: JUDGE_VERSION, scoringVersion: SCORING_VERSION,
      evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION, identity, freeze, freezeHash,
      labeledBy: 'codex-agent', humanReviewed: false, results: [], pairs: [], status: 'running' };
    activeSummary = summary;
    const save = () => {
      summary.usage = judge.usage(); summary.stageUsage = Object.fromEntries([BOUNDARY_STAGE, ...suite.stages].map(s => [s.id, judge.usage(s.id)]));
      summary.qualification = calibrationQualification(summary);
      summary.machineCalibrationPassed = summary.qualification.qualified;
      summary.notExecuted = suite.stages.flatMap(s => s.cases.filter(c => !summary.results.some(r => r.id === c.id)).map(c => ({ id: c.id, stage: s.id })));
      writeJson(path.join(directory, 'calibration.json'), summary);
    };
    const diagnosticFile = path.join(directory, 'boundary-diagnostics.json');
    judge.setStage(BOUNDARY_STAGE.id);
    let diagnostics = fs.existsSync(diagnosticFile) ? readJson(diagnosticFile) : null;
    if (diagnostics) invariant(diagnostics.freezeHash === freezeHash && diagnostics.fixtureHash === hash(suite.boundaryFixture), 'Cached boundary inputs changed');
    if (!diagnostics || diagnostics.results.some(r => ['budget_pending', 'provider_pending'].includes(r.pendingReason))) {
      registry.diagnosticExposures ||= [];
      for (const c of suite.boundaryFixture.cases) if (!registry.diagnosticExposures.some(e => e.roundId === suite.roundId && e.id === c.id)) registry.diagnosticExposures.push({ roundId: suite.roundId, id: c.id, propositionHash: hash(c.proposition), sourceHash: hash(c.sourceText) });
      writeJson(registryFile, registry);
      diagnostics = await runBoundaryDiagnostics({ fixture: suite.boundaryFixture, judge, freezeHash }); writeJson(diagnosticFile, diagnostics);
    }
    summary.boundaryDiagnostics = checkBoundaryDiagnostics(suite.boundaryFixture, diagnostics.results);
    save();
    if (judge.usage().unknownCalls || diagnostics.results.some(r => ['budget_pending', 'provider_pending'].includes(r.pendingReason))) {
      summary.status = 'paused'; summary.stopReason = 'boundary_budget_or_provider'; save(); return summary;
    }
    outer: for (const stage of suite.stages) {
      judge.setStage(stage.id);
      registry.rounds[suite.roundId].stages[stage.id] ||= { firstStartedAt: new Date().toISOString() };
      writeJson(registryFile, registry);
      for (const item of stage.cases) {
        invariant(evaluatorCodeIdentity() === freeze.codeIdentity && loadCalibrationSuite(suiteFile).suiteHash === suite.suiteHash, 'Calibration inputs changed during run');
        const file = path.join(directory, `${item.id}.json`);
        let score = fs.existsSync(file) ? readJson(file) : null;
        if (score) invariant(score.freezeHash === freezeHash && score.caseHash === hash(item), 'Cached calibration inputs changed');
        if (!registry.exposures.some(e => e.roundId === suite.roundId && e.id === item.id)) {
          registry.exposures.push({ id: item.id, roundId: suite.roundId, stage: stage.id, reportHash: reportKey(item.report),
            evidenceHash: hash(item.sources), family: item.family, firstUsedAt: new Date().toISOString() }); writeJson(registryFile, registry);
        }
        if (!score || !checkOracle(item, score).complete) {
          const args = { ...buildCalibrationArtifact(item), judge };
          if (item.mode === 'score') score = await evaluate(args);
          else {
            const extracted = await extractReportFacts(item.report, judge);
            score = { ...extracted, judgments: { facts: await verifyFacts({ ...args, facts: extracted.facts }) } };
          }
          Object.assign(score, { freezeHash, caseHash: hash(item) }); writeJson(file, score);
        }
        summary.results.push({ ...checkOracle(item, score), stage: stage.id });
        save();
        console.log(JSON.stringify({ calibration: item.id, stage: stage.id, matched: summary.results.at(-1).matched,
          complete: summary.results.at(-1).complete, tokens: summary.usage.confirmedTokens }));
        const failures = [...score.extraction.flatMap(b => [b.pendingReason, ...(b.bindingChecks || []).map(c => c.pendingReason)]),
          ...(score.bindings || []).map(b => b.pendingReason),
          ...score.judgments.facts.flatMap(f => [f.pendingReason, ...f.citations.map(c => c.pendingReason),
            ...(f.components?.truth?.checks || []).map(c => c.pendingReason),
            ...(f.components?.citations || []).flatMap(c => (c.review?.checks || []).map(check => check.pendingReason))]),
          ...(score.judgments.criteria || []).map(c => c.pendingReason)].filter(Boolean);
        if (judge.usage().unknownCalls || failures.some(f => ['budget_pending', 'provider_pending'].includes(f))) {
          summary.status = 'paused'; summary.stopReason = judge.usage().unknownCalls ? 'unknown_call' : 'stage_budget_or_provider'; save(); break outer;
        }
      }
      if (stage.id === 'assertion_holdout' && !calibrationQualification(summary).stages.find(s => s.id === stage.id).passed) {
        summary.status = 'stopped'; summary.stopReason = 'assertion_holdout_gate_failed'; save(); break;
      }
      if (stage.id === 'development' && (summary.results.some(r => !r.matched) || !summary.boundaryDiagnostics.passed)) {
        summary.status = 'stopped'; summary.stopReason = summary.results.some(r => !r.matched) ? 'development_gate_failed' : 'boundary_gate_failed'; save(); break;
      }
    }
    if (summary.status === 'running' && summary.results.length === 54) {
      summary.pairs = checkCalibrationPairs(suite, id => readJson(path.join(directory, `${id}.json`)));
      summary.status = 'finished';
    }
    invariant(evaluatorCodeIdentity() === freeze.codeIdentity && loadCalibrationSuite(suiteFile).suiteHash === suite.suiteHash
      && hash(freezeVerification(planFile, validationFile, freeze.codeIdentity)) === hash(verification), 'Calibration freeze changed');
    save(); return summary;
  } catch (error) {
    if (activeSummary) {
      activeSummary.status = 'paused'; activeSummary.stopReason = 'calibration_integrity_or_environment_failure';
      activeSummary.machineCalibrationPassed = false;
      if (activeSummary.qualification) activeSummary.qualification.qualified = false;
      writeJson(path.join(directory, 'calibration.json'), activeSummary);
      writeJson(path.join(directory, 'failure.json'), { phase: 'calibration', code: /^[A-Z_]+(?=:|$)/.exec(error.message)?.[0] || 'CALIBRATION_INVALID', at: new Date().toISOString() });
    }
    throw error;
  } finally { release?.(); releaseRegistry(); }
}
