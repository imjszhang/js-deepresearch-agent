import fs from 'node:fs';
import path from 'node:path';
import { FileRunRecorder, saveResearchArtifacts } from 'js-deepresearch-engine';
import { rebuildFromEvidence } from '../../../packages/js-deepresearch-engine/src/research/artifact-rebuild.mjs';
import { acquireSessionLock } from '../../../src/session-lock.mjs';
import { readJson, writeJson, hash, invariant, JUDGE_VERSION } from './schema.mjs';
import { loadResult, pinResult } from './load-result.mjs';
import { treeHash, publicSettings } from './campaign.mjs';

export function requireScoredBaseline(campaign, evaluationDirectory, calibration) {
  invariant(calibration?.machineCalibrationPassed === true && calibration.judgeVersion === JUDGE_VERSION, 'Calibration gate not met');
  const delivered = campaign.runs.filter(r => r.status === 'research_complete');
  invariant(delivered.length > 0, 'No delivered baseline reports');
  for (const run of delivered) {
    const score = readJson(path.join(evaluationDirectory, run.id, 'score.json'));
    invariant(score.resultPin.resultRevision === run.pin.resultRevision && score.resultPin.manifestHash === run.pin.manifestHash
      && score.calibrationHash === hash(calibration) && score.judgeVersion === JUDGE_VERSION && score.extractionComplete
      && !score.metrics.pendingReview, 'Baseline scoring is incomplete or incompatible');
  }
}

export async function runArtifactRebuilds({ campaign, directory, evaluationDirectory, calibration, settings, llm, signal }) {
  requireScoredBaseline(campaign, evaluationDirectory, calibration);
  const selected = campaign.runs.filter(r => r.repeat === 1);
  invariant(selected.length === 4 && selected.every(r => r.status === 'research_complete'), 'First four fixed cases must have delivered bodies');
  directory = path.resolve(directory);
  invariant(!selected.some(r => directory === path.resolve(r.pin.sessionDir) || directory.startsWith(path.resolve(r.pin.sessionDir) + path.sep)), 'Rebuild cannot overwrite original sessions');
  fs.mkdirSync(directory, { recursive: true });
  const release = acquireSessionLock(directory);
  const file = path.join(directory, 'campaign.json');
  try {
    const identity = { inputPins: selected.map(r => r.pin), calibrationHash: hash(calibration), settings: publicSettings(settings), settingsHash: hash(publicSettings(settings)),
      runtimeHash: treeHash('packages/js-deepresearch-engine/src'), harnessHash: treeHash('scripts/benchmark/quality') };
    const manifest = fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, id: path.basename(directory), mode: 'artifact_rebuild',
      identity, protocolVersion: campaign.protocolVersion, suiteHash: campaign.suiteHash,
      protocol: { totalTokens: 100000, judgeTokens: 100000, wallClockMs: 1800000, reportMaxOutputTokens: 16000 },
      runs: selected.map(r => ({ id: r.id, case: r.case, repeat: r.repeat, inputPin: r.pin, status: 'queued', attempts: [] })) };
    invariant(hash(manifest.identity) === hash(identity), 'Rebuild identity changed; do not reset the stage budget');
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
