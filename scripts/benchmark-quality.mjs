#!/usr/bin/env node
import { calibrationBudgetPlan } from './benchmark/quality/calibration-budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, applyResearchFlags } from '../src/cli-utils.mjs';
import { createLlmProvider, createRunExecutionConfig, resolveRunExecutionSettings, selectResearchResumePlan } from 'js-deepresearch-engine';
import { loadSuite, loadGold, validateGoldForCase, readJson, writeJson, hash, invariant, JUDGE_VERSION, EVALUATION_SCHEMA_VERSION, SCORING_VERSION } from './benchmark/quality/schema.mjs';
import { acquireSessionLock } from '../src/session-lock.mjs';
import { createCampaign, fingerprint, runCampaign, inspectGoogleTrust } from './benchmark/quality/campaign.mjs';
import { loadResult } from './benchmark/quality/load-result.mjs';
import { Judge } from './benchmark/quality/judge.mjs';
import { evaluate } from './benchmark/quality/evaluate.mjs';
import { diagnose } from './benchmark/quality/diagnose.mjs';
import { summarizeCampaign, compareCampaigns, compareSummaries, formatSummary } from './benchmark/quality/compare.mjs';
import { calibrate } from './benchmark/quality/calibrate.mjs';
import { runArtifactRebuilds } from './benchmark/quality/rebuild.mjs';
import { readImprovementGate } from './benchmark/quality/improvement-gate.mjs';
import { assessProgramExecutionGate, readProgramExecutionGate } from './benchmark/quality/improvement-gate.mjs';
import { runProgramVerification, requireProgramVerification } from './benchmark/quality/program-verification.mjs';
import { verifyArtifact, verifyCampaignArtifacts, assertIsolatedOutput } from './benchmark/quality/artifact-verification.mjs';
import { loadCalibrationSuite, requireCalibration, evaluationModelIdentity } from './benchmark/quality/calibration-suite.mjs';

function effectiveSettings(settings, protocol, cliPath) {
  return applyResearchFlags(settings, { strategy: 'exploratory', search: 'js-eyes', 'search-skills': protocol.skill,
    'search-cli': cliPath, 'search-server-url': protocol.serverUrl, 'search-language': protocol.language,
    'search-max-pages': protocol.searchMaxPages, concurrency: 1,
    'exploratory-min-llm-tokens': protocol.minTokens, 'exploratory-max-llm-tokens': protocol.maxTokens,
    'max-total-llm-tokens': protocol.totalTokens, 'report-max-output-tokens': protocol.reportMaxOutputTokens });
}

export function benchmarkExecutionMode(flags) {
  if (flags.mode === 'model-observation') {
    invariant(flags['program-verification'] && !flags.calibration, 'Model observation requires program verification and cannot mix legacy calibration');
    return 'model-observation';
  }
  invariant(!flags.mode && flags.calibration && !flags['program-verification'], 'Choose --mode model-observation with --program-verification, or legacy --calibration');
  return 'legacy-calibrated';
}

export function validateCachedObservation(score, { gold, artifact, identity, calibrationHash, mode }) {
  const hasFixture = value => value && typeof value === 'object' && (value.origin === 'scripted_fixture' || Object.values(value).some(hasFixture));
  invariant(score.goldHash === gold.goldHash && score.reportHash === artifact.reportHash && score.judgeVersion === JUDGE_VERSION
    && score.schemaVersion === EVALUATION_SCHEMA_VERSION && score.scoringVersion === SCORING_VERSION && hash(score.resultPin) === hash(artifact.pin)
    && hash(score.judgeIdentity) === hash(identity) && (score.calibrationHash || null) === calibrationHash
    && score.origin === 'model_assessment' && score.modelAssessment?.origin === 'model_assessment'
    && score.evaluationMode === mode && !hasFixture(score), 'Cached score input changed; use a new evaluation directory');
}

export async function main(argv) {
  const { args, flags } = parseArgs(argv);
  const command = args[0];
  if (flags.help || !command) {
    console.log(`Research quality benchmark (independent, revision-pinned)
  verify-program --output-dir <dir>
  verify-artifacts --campaign <file> --output-dir <dir>
  validate --suite <file> [--gold-dir <dir>]
  plan --suite <file> --output-dir <dir> --search-cli <executable> --skill-dir <dir>
  run --campaign <file> [--program-verification <file>] [--resume-run <id>]
  score --mode model-observation --program-verification <file> --campaign <file> --gold-dir <dir> [--evaluation-dir <dir>] [--run-id <id>] [--diagnose]
  score --calibration <file> --campaign <file> --gold-dir <dir> (legacy calibrated mode)
  summary --campaign <file> [--evaluation-dir <dir>]
  compare --baseline <file> --candidate <file>
  calibrate --suite <current-version suite> --output-dir <dir> --plan-file <file> --validation-file <file>
  calibration-validate --suite <current-version suite>
  calibration-summary --output-dir <dir>
  calibration-budget --suite <current-version suite>
  rebuild --campaign <baseline> --program-verification <file> --output-dir <dir>
  rebuild --campaign <baseline> --baseline-evaluation-dir <dir> --calibration <file> --output-dir <dir> (legacy)
  improvement-gate --gate-config <file>
  program-execution-gate --gate-config <file>
Program/artifact verification never loads credentials or calls external services. Program checks do not establish semantic accuracy.
Run never loads gold answers. Plan/validate do not call search or LLM.
Explicit run/score/calibrate/rebuild commands may call external services; rebuild calls only the LLM, never search or fetch. Raw artifacts remain local.`);
    return;
  }
  if (command === 'verify-program') {
    invariant(flags['output-dir'], 'verify-program requires output-dir');
    const record = await runProgramVerification({ outputDir: path.resolve(flags['output-dir']) });
    console.log(JSON.stringify({ status: record.status, verificationVersion: record.verificationVersion,
      implementationIdentity: record.implementationIdentity, file: path.join(path.resolve(flags['output-dir']), 'program-verification.json') }));
    if (record.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'verify-artifacts') {
    invariant(flags.campaign && flags['output-dir'], 'verify-artifacts requires campaign and output-dir');
    const record = verifyCampaignArtifacts({ campaign: readJson(flags.campaign), campaignFile: path.resolve(flags.campaign), outputDir: flags['output-dir'] });
    console.log(JSON.stringify({ status: record.status, plannedRuns: record.plannedRuns, checkedRuns: record.checkedRuns }));
    if (record.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'program-execution-gate') {
    invariant(flags['gate-config'], 'Gate config required');
    console.log(JSON.stringify(readProgramExecutionGate(path.resolve(flags['gate-config'])), null, 2)); return;
  }
  if (command === 'calibration-budget') {
    console.log(JSON.stringify(calibrationBudgetPlan(loadCalibrationSuite(flags.suite)))); return;
  }
  if (command === 'calibration-validate') {
    const suite = loadCalibrationSuite(path.resolve(flags.suite));
    console.log(JSON.stringify({ suiteHash: suite.suiteHash, stages: suite.stages.map(s => ({ id: s.id, count: s.cases.length, tokens: s.tokens })) })); return;
  }
  if (command === 'calibration-summary') {
    const s = readJson(path.join(flags['output-dir'], 'calibration.json'));
    console.log(JSON.stringify({ status: s.status, stopReason: s.stopReason, qualification: s.qualification, usage: s.usage, notExecuted: s.notExecuted.length })); return;
  }
  if (command === 'improvement-gate') {
    invariant(flags['gate-config'], 'Gate config required');
    console.log(JSON.stringify(readImprovementGate(path.resolve(flags['gate-config'])), null, 2)); return;
  }
  if (command === 'validate') {
    const suite = loadSuite(path.resolve(flags.suite));
    const gold = flags['gold-dir'] ? [...new Set(suite.cases.map(c => c.topicId))].map(id => loadGold(flags['gold-dir'], id)) : [];
    for (const c of suite.cases) { const g = gold.find(g => g.topicId === c.topicId); if (g) validateGoldForCase(g, c); }
    console.log(JSON.stringify({ cases: suite.cases.length, suiteHash: suite.suiteHash, rubrics: gold.map(g => ({ topicId: g.topicId, criteria: g.criteria.length, reviewStatus: g.reviewStatus, goldHash: g.goldHash })) }, null, 2));
    return;
  }
  if (command === 'summary' || command === 'compare') {
    if (command === 'summary') console.log(formatSummary(summarizeCampaign(readJson(flags.campaign), path.dirname(flags.campaign),
      { evaluationDirectory: flags['evaluation-dir'] })));
    else {
      const a = readJson(flags.baseline), b = readJson(flags.candidate);
      const comparison = compareCampaigns(a, b);
      const baseline = summarizeCampaign(a, path.dirname(flags.baseline), { evaluationDirectory: flags['baseline-evaluation-dir'] }),
        candidate = summarizeCampaign(b, path.dirname(flags.candidate), { evaluationDirectory: flags['candidate-evaluation-dir'] });
      console.log(JSON.stringify({ ...comparison, delivery: { baseline: baseline.deliverySuccessRate, candidate: candidate.deliverySuccessRate },
        cases: compareSummaries(baseline, candidate) }, null, 2));
    }
    return;
  }
  invariant(['calibrate', 'plan', 'run', 'score', 'rebuild'].includes(command), 'Unknown quality benchmark command');
  if (command === 'score') benchmarkExecutionMode(flags);
  if (command === 'rebuild') invariant(Boolean(flags['program-verification']) !== Boolean(flags.calibration), 'Choose program verification or legacy calibration for rebuild');
  await import('../src/config/bootstrap-env.mjs');
  const { createServices } = await import('../src/bootstrap.mjs');
  const { getDb, closeDb } = await import('../src/storage/db.mjs');
  const settings = createServices(getDb()).settingsStore.get();
  closeDb();
  if (command === 'calibrate') {
    invariant(flags['output-dir'] && flags.suite && !flags['holdout-file'], 'calibrate requires output-dir and a versioned suite');
    const identity = evaluationModelIdentity(settings);
    const summary = await calibrate({ llm: createLlmProvider(settings), identity, directory: flags['output-dir'], suiteFile: flags.suite, planFile: flags['plan-file'], validationFile: flags['validation-file'] });
    console.log(JSON.stringify({ status: summary.status, qualification: summary.qualification,
      passed: summary.machineCalibrationPassed, humanReviewed: false })); return;
  }
  if (command === 'plan') {
    invariant(flags['output-dir'] && flags['search-cli'] && flags['skill-dir'], 'plan requires output-dir, search-cli, skill-dir');
    invariant(!(flags['program-verification'] && flags['improvement-gate-config']), 'Cannot mix program and legacy gate');
    const suite = loadSuite(path.resolve(flags.suite));
    const campaign = createCampaign({ suite, directory: path.resolve(flags['output-dir']),
      identity: fingerprint(effectiveSettings(settings, suite.protocol, path.resolve(flags['search-cli'])), flags['skill-dir']), cliPath: path.resolve(flags['search-cli']), skillDir: path.resolve(flags['skill-dir']) });
    if (flags['improvement-gate-config']) {
      campaign.validationGate = path.resolve(flags['improvement-gate-config']);
      writeJson(path.join(flags['output-dir'], 'campaign.json'), campaign);
    }
    if (flags['program-verification']) {
      requireProgramVerification(flags['program-verification']);
      campaign.programGate = { schemaVersion: 2, programVerification: path.resolve(flags['program-verification']) };
      writeJson(path.join(flags['output-dir'], 'campaign.json'), campaign);
    }
    console.log(JSON.stringify({ campaign: path.join(flags['output-dir'], 'campaign.json'), plannedRuns: campaign.runs.length,
      protocol: campaign.protocol, runIds: campaign.runs.map(r => r.id) }, null, 2));
    return;
  }
  invariant(flags.campaign, 'Missing campaign');
  const file = path.resolve(flags.campaign), directory = path.dirname(file), campaign = readJson(file);
  if (command === 'rebuild') {
    invariant(!flags['gold-dir'] && flags['output-dir'], 'Rebuild requires output-dir and cannot load gold');
    assertIsolatedOutput(flags['output-dir'], [file]);
    const calibration = flags.calibration ? readJson(flags.calibration) : null;
    if (calibration) {
      invariant(flags['baseline-evaluation-dir'], 'Legacy rebuild requires frozen baseline scores');
      requireCalibration(calibration, evaluationModelIdentity(settings));
    }
    else {
      const gate = assessProgramExecutionGate({ programVerificationFile: flags['program-verification'], campaign, operation: 'rebuild', outputDir: flags['output-dir'] });
      invariant(gate.eligible, 'Program rebuild gate not met');
    }
    await runArtifactRebuilds({ campaign, directory: flags['output-dir'], evaluationDirectory: flags['baseline-evaluation-dir'], calibration,
      programVerificationFile: flags['program-verification'], settings, llm: createLlmProvider(settings) });
    return;
  }
  if (command === 'run') {
    invariant(!(campaign.validationGate && (campaign.programGate || flags['program-verification'])), 'Cannot mix program and legacy campaign gates');
    if (campaign.validationGate) invariant(readImprovementGate(campaign.validationGate).canLaunchLive, 'Improvement gate not met; live campaign remains queued');
    else {
      invariant(!campaign.programGate || campaign.programGate.schemaVersion === 2, 'PROGRAM_GATE_SCHEMA_INVALID');
      const gate = assessProgramExecutionGate({ programVerificationFile: flags['program-verification'] || campaign.programGate?.programVerification, campaign, operation: 'run' });
      invariant(gate.eligible, 'Program execution gate not met; live campaign remains queued');
    }
    invariant(!flags['gold-dir'], 'run cannot load gold');
    const preflight = inspectGoogleTrust(campaign.cliPath, campaign.protocol.skill);
    writeJson(path.join(directory, `preflight-${Date.now()}.json`), preflight);
    const controller = new AbortController();
    const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { await runCampaign({ file, currentIdentity: fingerprint(effectiveSettings(settings, campaign.protocol, campaign.cliPath), campaign.skillDir), signal: controller.signal,
      beforeRun: (run) => {
        const fresh = createServices(getDb()).settingsStore.get(); closeDb();
        invariant(hash(fingerprint(effectiveSettings(fresh, campaign.protocol, campaign.cliPath), campaign.skillDir)) === hash(campaign.identity), 'Frozen runtime/configuration changed between runs');
        inspectGoogleTrust(campaign.cliPath, campaign.protocol.skill);
        let actual = effectiveSettings(fresh, campaign.protocol, campaign.cliPath);
        if (run.resumeSession) actual = resolveRunExecutionSettings(actual, { sessionDir: run.resumeSession,
          checkpoint: selectResearchResumePlan({ sessionDir: run.resumeSession }).checkpoint?.state }).settings;
        return { configHash: createRunExecutionConfig(actual).configHash };
      },
      resumeRun: flags['resume-run'], onProgress: p => console.log(JSON.stringify(p)) }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (command === 'score') {
    invariant(flags['gold-dir'], 'score requires gold-dir');
    invariant(campaign.origin !== 'scripted_fixture', 'Scripted fixtures cannot be scored as live observations');
    const mode = benchmarkExecutionMode(flags);
    const identity = evaluationModelIdentity(settings);
    const calibration = flags.calibration ? readJson(flags.calibration) : null;
    let verification = null;
    if (mode === 'legacy-calibrated') requireCalibration(calibration, identity);
    else verification = requireProgramVerification(flags['program-verification']);
    const calibrationHash = calibration ? hash(calibration) : null;
    if (calibration) identity.calibrationHash = calibrationHash;
    const evaluationDirectory = path.resolve(flags['evaluation-dir'] || path.join(directory, 'evaluations', `${JUDGE_VERSION}-${mode}`));
    assertIsolatedOutput(evaluationDirectory, [file, ...campaign.runs.map(r => r.pin?.sessionDir)]);
    if (verification) invariant(assessProgramExecutionGate({ programVerificationFile: flags['program-verification'], campaign, operation: 'score', outputDir: evaluationDirectory }).eligible, 'Program scoring gate not met');
    const llm = createLlmProvider(settings);
    for (const run of campaign.runs.filter(r => r.status === 'research_complete' && (!flags['run-id'] || r.id === flags['run-id']))) {
      const out = path.join(evaluationDirectory, run.id), scoreFile = path.join(out, 'score.json');
      const gold = loadGold(flags['gold-dir'], run.case.topicId);
      validateGoldForCase(gold, run.case);
      const artifact = loadResult(run.pin);
      invariant(artifact.result.benchmarkOrigin !== 'scripted_fixture', 'Scripted artifact cannot be scored as a live observation');
      fs.mkdirSync(out, { recursive: true });
      const releaseScore = acquireSessionLock(out);
      try {
      const judge = new Judge({ llm, directory: path.join(out, 'judge'), limit: campaign.protocol.judgeTokens, identity });
      const stateFile = path.join(out, 'evaluation-state.json');
      const updateState = status => writeJson(stateFile, { status, judgeVersion: JUDGE_VERSION, updatedAt: new Date().toISOString(),
        resultRevision: run.pin.resultRevision, scoreAvailable: fs.existsSync(scoreFile), judgeUsage: judge.usage() });
      updateState('evaluating');
      let phase = 'score';
      try {
        let score;
        if (fs.existsSync(scoreFile)) {
          score = readJson(scoreFile);
          validateCachedObservation(score, { gold, artifact, identity, calibrationHash, mode });
        }
        if (!score || score.metrics.pendingReview || !score.extractionComplete) {
          score = await evaluate({ artifact, gold, caseDefinition: run.case, judge });
          score.calibrationHash = calibrationHash;
          score.calibration = calibration ? { judgeVersion: calibration.judgeVersion, suiteHash: calibration.freeze.suiteHash,
            qualification: calibration.qualification, machineCalibrationPassed: calibration.machineCalibrationPassed,
            humanReviewed: calibration.humanReviewed } : null;
          score.evaluationMode = mode;
          score.programVerification = verification ? { verificationVersion: verification.verificationVersion,
            implementationIdentity: verification.implementationIdentity } : null;
          score.artifactVerification = verifyArtifact(run.pin);
          writeJson(scoreFile, score);
        }
        writeJson(path.join(out, 'review-items.json'), { reviewStatus: score.reviewStatus,
          criteria: score.rows.filter(r => r.critical || r.pending || r.conflict || r.points < 1),
          facts: score.judgments.facts.filter((f, i) => f.majorError || f.truth !== 'correct' || i % 5 === 0),
          extractionBlocks: score.extraction, humanReviewed: false });
        phase = 'diagnose';
        updateState(flags.diagnose ? 'diagnosing' : 'evaluated');
        if (flags.diagnose && !fs.existsSync(path.join(out, 'diagnostics.json'))) writeJson(path.join(out, 'diagnostics.json'), await diagnose({ score, artifact, gold, judge }));
        const status = score.extractionComplete && !score.metrics.pendingReview ? 'evaluated' : 'evaluation_pending';
        updateState(status);
        console.log(JSON.stringify({ id: run.id, status, metrics: score.metrics, judgeUsage: judge.usage() }));
      } catch (error) {
        const failureFile = phase === 'diagnose' ? 'diagnostics-failure.json' : 'evaluation-failure.json';
        const failure = { phase, createdAt: new Date().toISOString(), judgeVersion: JUDGE_VERSION,
          code: /^[A-Z_]+(?=:|$)/.exec(error.message)?.[0] || 'EVALUATION_INVALID', judgeUsage: judge.usage() };
        writeJson(path.join(out, failureFile), failure);
        writeJson(path.join(out, 'evaluation-failures', `${hash(failure)}.json`), failure);
        updateState(phase === 'diagnose' ? 'diagnostics_pending' : 'evaluation_pending');
        console.log(JSON.stringify({ id: run.id, status: phase === 'diagnose' ? 'diagnostics_pending' : 'evaluation_pending', error: `See local ${failureFile}` }));
      }
      } finally { releaseScore(); }
    }
    const summary = summarizeCampaign(campaign, directory, { evaluationDirectory });
    fs.mkdirSync(evaluationDirectory, { recursive: true });
    fs.writeFileSync(path.join(evaluationDirectory, 'comparison.md'), formatSummary(summary));
    return;
  }
  throw new Error('Unknown quality benchmark command');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2)).catch(() => {
  console.error('Quality benchmark failed. Check arguments, frozen inputs, and local structured failure records.'); process.exitCode = 1;
});
