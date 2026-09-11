import fs from 'node:fs';
import path from 'node:path';
import { FileRunRecorder, saveResearchArtifacts } from 'js-deepresearch-engine';
import { rebuildFromEvidence } from '../../../packages/js-deepresearch-engine/src/research/artifact-rebuild.mjs';
import { acquireSessionLock } from '../../../src/session-lock.mjs';
import { readJson, writeJson, hash, invariant, JUDGE_VERSION } from './schema.mjs';
import { loadResult, pinResult } from './load-result.mjs';
import { treeHash, publicSettings } from './campaign.mjs';
import { requireCalibration } from './calibration-suite.mjs';
import { requireProgramVerification } from './program-verification.mjs';
import { verifyArtifact, assertIsolatedOutput } from './artifact-verification.mjs';

const preparedRebuild = Symbol('preparedRebuild');
function prepareInputs(campaign, directory, authorization) {
  const selected = campaign.runs.filter(r => r.repeat === 1);
  invariant(selected.length === 4 && selected.every(r => r.status === 'research_complete'), 'First four fixed cases must have delivered bodies');
  invariant(new Set(selected.map(r => r.id)).size === selected.length, 'Duplicate rebuild inputs');
  directory = assertIsolatedOutput(directory, campaign.runs.map(r => r.pin?.sessionDir));
  for (const run of selected) {
    verifyArtifact(run.pin);
    invariant(loadResult(run.pin).result.benchmarkOrigin !== 'scripted_fixture', 'Scripted artifact is not a live rebuild baseline');
  }
  return { [preparedRebuild]: true, campaign, selected, directory, authorization };
}
export function requireRebuildInputs({ campaign, directory, programVerificationFile }, { verifyProgram = requireProgramVerification } = {}) {
  const verification = verifyProgram(programVerificationFile);
  invariant(campaign?.origin !== 'scripted_fixture', 'Scripted fixture is not a live rebuild baseline');
  return prepareInputs(campaign, directory, { mode: 'program_verified', implementationIdentity: verification.implementationIdentity });
}

export function requireScoredBaseline(campaign, evaluationDirectory, calibration) {
  requireCalibration(calibration);
  const delivered = campaign.runs.filter(r => r.status === 'research_complete');
  invariant(delivered.length > 0, 'No delivered baseline reports');
  for (const run of delivered) {
    const score = readJson(path.join(evaluationDirectory, run.id, 'score.json'));
    invariant(score.resultPin.resultRevision === run.pin.resultRevision && score.resultPin.manifestHash === run.pin.manifestHash
      && score.calibrationHash === hash(calibration) && score.judgeVersion === JUDGE_VERSION && score.extractionComplete
      && !score.metrics.pendingReview, 'Baseline scoring is incomplete or incompatible');
  }
}

export async function runArtifactRebuilds({ campaign, directory, evaluationDirectory, calibration, programVerificationFile, settings, llm, signal }) {
  invariant(!(programVerificationFile && calibration), 'Cannot mix program verification and legacy calibration');
  let prepared;
  if (programVerificationFile) prepared = requireRebuildInputs({ campaign, directory, programVerificationFile });
  else {
    requireScoredBaseline(campaign, evaluationDirectory, calibration);
    prepared = prepareInputs(campaign, directory, { mode: 'legacy_calibrated', calibrationHash: hash(calibration) });
  }
  return executeArtifactRebuilds({ prepared, settings, llm, signal });
}

export async function executeArtifactRebuilds({ prepared, settings, llm, signal }) {
  invariant(prepared?.[preparedRebuild] === true, 'Rebuild requires verified inputs');
  const { campaign, selected, directory, authorization } = prepared;
  fs.mkdirSync(directory, { recursive: true });
  const release = acquireSessionLock(directory);
  const file = path.join(directory, 'campaign.json');
  try {
    const origin = llm?.assessmentOrigin === 'scripted_fixture' ? 'scripted_fixture' : 'model_assessment';
    const identity = { inputPins: selected.map(r => r.pin), authorization, origin, settings: publicSettings(settings), settingsHash: hash(publicSettings(settings)),
      runtimeHash: treeHash('packages/js-deepresearch-engine/src'), harnessHash: treeHash('scripts/benchmark/quality') };
    const manifest = fs.existsSync(file) ? readJson(file) : { schemaVersion: 2, id: path.basename(directory), mode: 'artifact_rebuild', origin,
      identity, protocolVersion: campaign.protocolVersion, suiteHash: campaign.suiteHash,
      protocol: { totalTokens: 100000, judgeTokens: 100000, wallClockMs: 1800000, reportMaxOutputTokens: 16000 },
      runs: selected.map(r => ({ id: r.id, case: r.case, repeat: r.repeat, inputPin: r.pin, status: 'queued', attempts: [] })) };
    invariant(manifest.schemaVersion === 2 && hash(manifest.identity) === hash(identity), 'Rebuild identity changed; do not reset the stage budget');
    manifest.status = 'running';
    writeJson(file, manifest);
    for (const run of manifest.runs) {
      if (run.status === 'research_complete') continue;
      signal?.throwIfAborted();
      for (const attempt of run.attempts.filter(a => a.activeMs == null)) {
        attempt.activeMs = Math.min(1800000, Math.max(0, Date.now() - Date.parse(attempt.startedAt)));
        attempt.timingBasis = 'conservative_interruption_bound';
      }
      const remaining = 1800000 - run.attempts.reduce((n, a) => n + a.activeMs, 0);
      invariant(remaining > 0, 'ARTIFACT_REBUILD_WALL_CLOCK_EXCEEDED');
      const attempt = { startedAt: new Date().toISOString(), activeMs: null }; run.attempts.push(attempt);
      const started = Date.now();
      run.status = 'running'; writeJson(file, manifest);
      const sessionDir = path.join(directory, run.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const recorder = fs.existsSync(path.join(sessionDir, 'run.json')) ? FileRunRecorder.reopen(sessionDir)
        : new FileRunRecorder({ sessionDir, query: run.case.query, strategy: 'artifact_rebuild' });
      try {
        const artifact = loadResult(run.inputPin);
        const result = await rebuildFromEvidence({ query: run.case.query, evidenceStore: artifact.store.export(), inputPin: run.inputPin,
          settings, llm, recorder, signal: signal ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(remaining)]) : globalThis.AbortSignal.timeout(remaining) });
        result.benchmarkOrigin = origin;
        saveResearchArtifacts({ sessionDir, query: run.case.query, strategy: 'artifact_rebuild', settings, result });
        recorder.finalize('completed');
        run.pin = pinResult(sessionDir); run.status = 'research_complete';
      } catch (error) {
        run.status = 'research_failed'; manifest.status = 'paused';
        run.failureCode = error.code || error.name;
        recorder.finalize('failed', { error });
      } finally {
        attempt.activeMs = Date.now() - started; attempt.finishedAt = new Date().toISOString();
        writeJson(file, manifest);
      }
      console.log(JSON.stringify({ rebuild: run.id, status: run.status }));
      if (manifest.status === 'paused') break;
    }
    if (manifest.runs.every(r => r.status === 'research_complete')) manifest.status = 'finished';
    writeJson(file, manifest);
    return manifest;
  } finally { release(); }
}
