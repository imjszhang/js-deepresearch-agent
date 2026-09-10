#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../src/config/bootstrap-env.mjs';
import { createServices } from '../src/bootstrap.mjs';
import { getDb, closeDb } from '../src/storage/db.mjs';
import { parseArgs, applyResearchFlags } from '../src/cli-utils.mjs';
import { createLlmProvider, createRunExecutionConfig, resolveRunExecutionSettings, selectResearchResumePlan } from 'js-deepresearch-engine';
import { loadSuite, loadGold, validateGoldForCase, readJson, writeJson, hash, invariant, JUDGE_VERSION } from './benchmark/quality/schema.mjs';
import { createCampaign, fingerprint, runCampaign, publicSettings, inspectGoogleTrust } from './benchmark/quality/campaign.mjs';
import { loadResult } from './benchmark/quality/load-result.mjs';
import { Judge } from './benchmark/quality/judge.mjs';
import { evaluate } from './benchmark/quality/evaluate.mjs';
import { diagnose } from './benchmark/quality/diagnose.mjs';
import { summarizeCampaign, compareCampaigns, compareSummaries, formatSummary } from './benchmark/quality/compare.mjs';
import { calibrate } from './benchmark/quality/calibrate.mjs';
import { runArtifactRebuilds } from './benchmark/quality/rebuild.mjs';
import { readImprovementGate } from './benchmark/quality/improvement-gate.mjs';

function effectiveSettings(settings, protocol, cliPath) {
  return applyResearchFlags(settings, { strategy: 'exploratory', search: 'js-eyes', 'search-skills': protocol.skill,
    'search-cli': cliPath, 'search-server-url': protocol.serverUrl, 'search-language': protocol.language,
    'search-max-pages': protocol.searchMaxPages, concurrency: 1,
    'exploratory-min-llm-tokens': protocol.minTokens, 'exploratory-max-llm-tokens': protocol.maxTokens,
    'max-total-llm-tokens': protocol.totalTokens, 'report-max-output-tokens': protocol.reportMaxOutputTokens });
}

export async function main(argv) {
  const { args, flags } = parseArgs(argv);
  const command = args[0];
  if (flags.help || !command) {
    console.log(`Research quality benchmark (independent, revision-pinned)
  validate --suite <file> [--gold-dir <dir>]
  plan --suite <file> --output-dir <dir> --search-cli <executable> --skill-dir <dir>
  run --campaign <file> [--resume-run <id>]
  score --campaign <file> --gold-dir <dir> --calibration <file> [--evaluation-dir <dir>] [--run-id <id>] [--diagnose]
  summary --campaign <file> [--evaluation-dir <dir>]
  compare --baseline <file> --candidate <file>
  calibrate --output-dir <dir> --holdout-file <fresh versioned fixture>
  rebuild --campaign <baseline> --baseline-evaluation-dir <dir> --calibration <file> --output-dir <dir>
  improvement-gate --gate-config <file>
Run never loads gold answers. Plan/validate do not call search or LLM.
Explicit run/score/calibrate/rebuild commands may call external services; rebuild calls only the LLM, never search or fetch. Raw artifacts remain local.`);
    return;
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
      const av = [...new Set(baseline.runs.filter(r => r.score).map(r => `${r.score.goldHash}:${r.score.judgeVersion}:${hash(r.score.judgeIdentity)}`))].sort();
      const bv = [...new Set(candidate.runs.filter(r => r.score).map(r => `${r.score.goldHash}:${r.score.judgeVersion}:${hash(r.score.judgeIdentity)}`))].sort();
      if (hash(av) !== hash(bv)) { comparison.comparable = false; comparison.warnings.push('Different or incomplete gold/judge versions'); }
      console.log(JSON.stringify({ ...comparison, delivery: { baseline: baseline.deliverySuccessRate, candidate: candidate.deliverySuccessRate },
        cases: compareSummaries(baseline, candidate) }, null, 2));
    }
    return;
  }
  const settings = createServices(getDb()).settingsStore.get();
  closeDb();
  if (command === 'calibrate') {
    invariant(flags['output-dir'] && flags['holdout-file'], 'calibrate requires output-dir and a fresh holdout-file');
    const identity = publicSettings({ provider: settings.llm.provider, model: settings.llm.model, baseUrl: settings.llm.baseUrl });
    const summary = await calibrate({ llm: createLlmProvider(settings), identity, directory: flags['output-dir'], holdoutFile: flags['holdout-file'] });
    console.log(JSON.stringify({ agreement: summary.agreement, holdoutAgreement: summary.holdoutAgreement, criticalMisses: summary.criticalMisses,
      passed: summary.machineCalibrationPassed, humanReviewed: false })); return;
  }
  if (command === 'plan') {
    invariant(flags['output-dir'] && flags['search-cli'] && flags['skill-dir'], 'plan requires output-dir, search-cli, skill-dir');
    const suite = loadSuite(path.resolve(flags.suite));
    const campaign = createCampaign({ suite, directory: path.resolve(flags['output-dir']),
      identity: fingerprint(effectiveSettings(settings, suite.protocol, path.resolve(flags['search-cli'])), flags['skill-dir']), cliPath: path.resolve(flags['search-cli']), skillDir: path.resolve(flags['skill-dir']) });
    if (flags['improvement-gate-config']) {
      campaign.validationGate = path.resolve(flags['improvement-gate-config']);
      writeJson(path.join(flags['output-dir'], 'campaign.json'), campaign);
    }
    console.log(JSON.stringify({ campaign: path.join(flags['output-dir'], 'campaign.json'), plannedRuns: campaign.runs.length,
      protocol: campaign.protocol, runIds: campaign.runs.map(r => r.id) }, null, 2));
    return;
  }
  invariant(flags.campaign, 'Missing campaign');
  const file = path.resolve(flags.campaign), directory = path.dirname(file), campaign = readJson(file);
  if (command === 'rebuild') {
    invariant(!flags['gold-dir'] && flags.calibration && flags['baseline-evaluation-dir'] && flags['output-dir'], 'Rebuild requires frozen baseline scores and calibration, and cannot load gold');
    const calibration = readJson(flags.calibration);
    const identity = publicSettings({ provider: settings.llm.provider, model: settings.llm.model, baseUrl: settings.llm.baseUrl });
    invariant(['provider', 'model', 'baseUrl'].every(k => calibration.identity[k] === identity[k]), 'Calibration differs from current model');
    await runArtifactRebuilds({ campaign, directory: flags['output-dir'], evaluationDirectory: flags['baseline-evaluation-dir'], calibration,
      settings, llm: createLlmProvider(settings) });
    return;
  }
  if (command === 'run') {
    if (campaign.validationGate) invariant(readImprovementGate(campaign.validationGate).canLaunchLive, 'Improvement gate not met; live campaign remains queued');
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
    const identity = publicSettings({ provider: settings.llm.provider, model: settings.llm.model, baseUrl: settings.llm.baseUrl, temperature: 0,
      sameModelAsResearch: settings.llm.model === (campaign.identity.settings?.llm?.model || settings.llm.model) });
    const llm = createLlmProvider(settings);
    const calibration = flags.calibration ? readJson(flags.calibration) : null;
    invariant(calibration?.machineCalibrationPassed === true, 'A passing frozen calibration is required before formal scoring');
    if (calibration) invariant(calibration.judgeVersion === JUDGE_VERSION
      && ['provider', 'model', 'baseUrl'].every(k => calibration.identity[k] === identity[k]), 'Calibration differs from current judge');
    const calibrationHash = calibration ? hash(calibration) : null;
    identity.calibrationHash = calibrationHash;
    const evaluationDirectory = path.resolve(flags['evaluation-dir'] || path.join(directory, 'evaluations', JUDGE_VERSION));
    invariant(evaluationDirectory !== directory, 'Use a separate evaluation revision directory');
    for (const run of campaign.runs.filter(r => r.status === 'research_complete' && (!flags['run-id'] || r.id === flags['run-id']))) {
      const out = path.join(evaluationDirectory, run.id), scoreFile = path.join(out, 'score.json');
      const gold = loadGold(flags['gold-dir'], run.case.topicId);
      validateGoldForCase(gold, run.case);
      const artifact = loadResult(run.pin);
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
          invariant(score.goldHash === gold.goldHash && score.reportHash === artifact.reportHash && score.judgeVersion === JUDGE_VERSION
            && hash(score.judgeIdentity) === hash(identity) && (score.calibrationHash || null) === calibrationHash, 'Cached score input changed; use a new evaluation directory');
        } else {
          score = await evaluate({ artifact, gold, caseDefinition: run.case, judge });
          score.calibrationHash = calibrationHash;
          score.calibration = calibration ? { judgeVersion: calibration.judgeVersion, agreement: calibration.agreement,
            criticalMisses: calibration.criticalMisses, machineCalibrationPassed: calibration.machineCalibrationPassed,
            humanReviewed: calibration.humanReviewed } : null;
          score.machineThresholdsMet = score.qualityTargetMet;
          score.qualityTargetMet = score.machineThresholdsMet && calibration?.machineCalibrationPassed === true;
          if (!calibration?.machineCalibrationPassed) score.reviewStatus = 'pending_review';
          writeJson(scoreFile, score);
        }
        writeJson(path.join(out, 'review-items.json'), { reviewStatus: score.reviewStatus,
          criteria: score.rows.filter(r => r.critical || r.pending || r.conflict || r.points < 1),
          facts: score.judgments.facts.filter((f, i) => f.majorError || f.truth !== 'correct' || i % 5 === 0),
          extractionBlocks: score.extraction, humanReviewed: false });
        phase = 'diagnose';
        updateState(flags.diagnose ? 'diagnosing' : 'evaluated');
        if (flags.diagnose && !fs.existsSync(path.join(out, 'diagnostics.json'))) writeJson(path.join(out, 'diagnostics.json'), await diagnose({ score, artifact, gold, judge }));
        const status = score.extractionComplete && !score.rows.some(r => r.pending) ? 'evaluated' : 'evaluation_pending';
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
