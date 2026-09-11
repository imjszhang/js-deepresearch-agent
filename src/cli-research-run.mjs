import fs from 'node:fs';
import path from 'node:path';
import {
  FileRunRecorder,
  ResearchRunner,
  collectManualImportHints,
  createWorkSessionDir,
  saveResearchArtifacts,
  isReportResumeMode,
  selectResearchResumePlan,
  normalizePlanningContext,
  resolveRunExecutionSettings,
} from 'js-deepresearch-engine';
import { completeResearch, recordResearchFailure, deliveryFailure } from './research-completion.mjs';
import { acquireSessionLock } from './session-lock.mjs';
import { probeSearchProvider } from './search-preflight.mjs';
import { parseResumeExploreFlags } from './cli-utils.mjs';

export class ResearchCancelledError extends Error {
  constructor(message = 'Research cancelled.') {
    super(message);
    this.name = 'ResearchCancelledError';
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function createResearchAbortController({
  onFirstCancel,
  signalTarget = process,
} = {}) {
  const controller = new AbortController();
  let cancelRequested = false;

  function onSignal() {
    if (controller.signal.aborted) {
      remove();
      process.exit(130);
    }

    cancelRequested = true;
    onFirstCancel?.();
    controller.abort();
  }

  function install() {
    signalTarget.on('SIGINT', onSignal);
    signalTarget.on('SIGTERM', onSignal);
  }

  function remove() {
    signalTarget.removeListener('SIGINT', onSignal);
    signalTarget.removeListener('SIGTERM', onSignal);
  }

  return {
    controller,
    install,
    remove,
    get cancelRequested() {
      return cancelRequested;
    },
  };
}

export async function runCliResearch({
  query,
  planningContext,
  settings,
  flags,
  services,
  runner = new ResearchRunner(),
  createSessionDir = createWorkSessionDir,
  createRecorder = (options) => new FileRunRecorder(options),
  saveArtifacts = saveResearchArtifacts,
  writeFile = fs.writeFileSync.bind(fs),
  cryptoRandomId = defaultCryptoRandomId,
  signalTarget = process,
  onProgressLog = defaultProgressLog,
  probeSearch = probeSearchProvider,
}) {
  const contextFile = flags['planning-context'];
  if (contextFile === true) throw new TypeError('--planning-context requires a JSON file.');
  planningContext = normalizePlanningContext(contextFile
    ? JSON.parse(fs.readFileSync(path.resolve(contextFile), 'utf8')) : planningContext);
  const { controller, install, remove } = createResearchAbortController({
    signalTarget,
    onFirstCancel: () => {
      onProgressLog('info', '-', 'Cancellation requested. Stopping research...');
    },
  });

  install();
  let recordId = null;
  let sessionDir = null;
  let recorder = null;
  let releaseLock = null;

  try {
    await probeSearch(settings, { signal: controller.signal });
    const runId = cryptoRandomId();
    if (!flags['no-save']) {
      recordId = runId;
      services.researchRepository.create({
        id: recordId,
        query,
        strategy: settings.research.strategy,
      });
    }
    if (!flags['no-work-dir']) {
      sessionDir = createSessionDir({
        settings,
        strategy: settings.research.strategy,
      });
      if (recordId) {
        services.researchRepository.updateStatus(recordId, 'running', { sessionDir });
      }
      releaseLock = acquireSessionLock(sessionDir);
      recorder = createRecorder({
        sessionDir,
        runId,
        strategy: settings.research.strategy,
        query,
        metadata: { settings },
      });
    } else if (recordId) {
      services.researchRepository.updateStatus(recordId, 'running');
    }

    const result = await runner.run({
      query,
      planningContext,
      settings,
      signal: controller.signal,
      recorder,
      onProgress: ({ message, progress, level }) => {
        onProgressLog(level, progress, message);
      },
    });

    const outcome = await completeResearch({
      id: recordId, result, query, strategy: settings.research.strategy, settings,
      sessionDir, recorder, services, saveArtifacts, writeFile, output: flags.output,
      signal: controller.signal,
      onWarning: ({ stage, code }) => onProgressLog('warn', '-', `Delivery ${stage} failed (${code}); research result retained.`),
    });
    reportCompletionHints(outcome, settings, flags, onProgressLog);
    return outcome;
  } catch (error) {
    const cancelled = isAbortError(error) || controller.signal.aborted;
    recordResearchFailure({ recorder, repository: services.researchRepository, id: recordId, error, cancelled });
    if (cancelled) throw new ResearchCancelledError();
    throw error;
  } finally {
    releaseLock?.();
    remove();
  }
}

export async function runCliResearchResume({
  sessionDir,
  settings,
  flags,
  resumeExplore = null,
  services,
  runner = new ResearchRunner(),
  createRecorder = (dir) => FileRunRecorder.reopen(dir),
  saveArtifacts = saveResearchArtifacts,
  writeFile = fs.writeFileSync.bind(fs),
  signalTarget = process,
  onProgressLog = defaultProgressLog,
  probeSearch = probeSearchProvider,
}) {
  const resolvedSessionDir = path.resolve(sessionDir);
  const runPath = path.join(resolvedSessionDir, 'run.json');
  if (!fs.existsSync(runPath)) {
    throw new Error(`Cannot resume: missing run.json in ${resolvedSessionDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const query = manifest.query;
  const strategy = manifest.strategy || settings.research?.strategy || 'focused';
  const runId = manifest.runId || null;

  const { controller, install, remove } = createResearchAbortController({
    signalTarget,
    onFirstCancel: () => {
      onProgressLog('info', '-', 'Cancellation requested. Stopping research...');
    },
  });

  install();
  let recordId = null;
  let recorder = null;
  let releaseLock = null;
  let preserveCommittedResult = false;

  try {
    releaseLock = acquireSessionLock(resolvedSessionDir);
    const exploreFlags = resumeExplore || parseResumeExploreFlags(flags);
    const resumePlan = selectResearchResumePlan({
      sessionDir: resolvedSessionDir,
      continueExplore: exploreFlags.continueExplore,
      extraSteps: exploreFlags.extraSteps,
    });
    if (resumePlan.mode !== 'commit-result') settings = resolveRunExecutionSettings(settings, {
      sessionDir: resolvedSessionDir, checkpoint: resumePlan.checkpoint?.state,
    }).settings;
    if (!flags['no-save'] && runId) {
      recordId = runId;
      const existing = services.researchRepository.get(recordId);
      preserveCommittedResult = resumePlan.mode === 'commit-result' && existing?.status === 'completed';
      if (!existing) {
        services.researchRepository.create({
          id: recordId,
          query,
          strategy,
        });
      }
      if (resumePlan.mode !== 'commit-result' || existing?.status !== 'completed') services.researchRepository.updateStatus(recordId, 'running', {
        error: null,
        sessionDir: resolvedSessionDir,
        completedAt: null,
      });
    }

    recorder = createRecorder(resolvedSessionDir);
    if (isReportResumeMode(resumePlan.mode)) {
      onProgressLog('info', '-', resumePlan.mode === 'commit-result' ? `Restoring completed result from ${resolvedSessionDir}` : `Resuming report phase from ${resolvedSessionDir}`);
    } else {
      onProgressLog(
        'info',
        '-',
        resumePlan.mode === 'continue-explore'
          ? `Continuing exploration (+${resumePlan.extraSteps} steps) from ${resolvedSessionDir}`
          : `Resuming exploratory loop from ${resolvedSessionDir}`,
      );
      await probeSearch(settings, { signal: controller.signal });
    }

    const result = await runner.resumeFromSession({
      sessionDir: resolvedSessionDir,
      settings,
      signal: controller.signal,
      recorder,
      continueExplore: exploreFlags.continueExplore,
      extraSteps: exploreFlags.extraSteps,
      extraSearches: exploreFlags.extraSearches,
      extraReads: exploreFlags.extraReads,
      onProgress: ({ message, progress, level }) => {
        onProgressLog(level, progress, message);
      },
    });

    const outcome = await completeResearch({
      id: recordId, result, query, strategy, settings,
      sessionDir: resolvedSessionDir, recorder, services, saveArtifacts, writeFile, output: flags.output,
      signal: controller.signal,
      onWarning: ({ stage, code }) => onProgressLog('warn', '-', `Delivery ${stage} failed (${code}); research result retained.`),
    });
    reportCompletionHints(outcome, settings, flags, onProgressLog);
    return outcome;
  } catch (error) {
    const cancelled = isAbortError(error) || controller.signal.aborted;
    if (preserveCommittedResult) {
      try { services.researchRepository.saveDelivery?.(recordId, { failures: [deliveryFailure('resume', error)] }); } catch { /* result already committed */ }
    } else recordResearchFailure({ recorder, repository: services.researchRepository, id: recordId, error, cancelled });
    if (cancelled) throw new ResearchCancelledError();
    throw error;
  } finally {
    releaseLock?.();
    remove();
  }
}

function defaultCryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultProgressLog(level, progress, message) {
  console.error(`[${level}] ${progress ?? '-'}% ${message}`);
}

function reportCompletionHints({ result, artifacts }, settings, flags, log) {
  // Reporting after commit is best effort, just like SSE delivery.
  try {
    if (artifacts && !flags.json) log('info', '-', `Artifacts saved to ${artifacts.reportPath}`);
    if (!flags.json) for (const hint of collectManualImportHints({
      gaps: result.gaps || [], readiness: result.readiness || result.quality?.readiness || null,
      findings: result.findings || [], corpusDirs: settings.search?.local?.dirs || [],
    })) log('info', '-', hint);
  } catch { /* result already committed */ }
}
