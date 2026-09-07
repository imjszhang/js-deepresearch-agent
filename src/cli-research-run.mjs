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
} from 'js-deepresearch-engine';
import { archiveResearchResultSafe } from './storage/intel-store.mjs';
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
      settings,
      signal: controller.signal,
      recorder,
      onProgress: ({ message, progress, level }) => {
        onProgressLog(level, progress, message);
      },
    });

    let artifacts = null;
    if (!flags['no-work-dir']) {
      artifacts = saveArtifacts({
        sessionDir,
        settings,
        strategy: settings.research.strategy,
        query,
        result,
        researchId: recordId || undefined,
      });
      if (!flags.json) {
        onProgressLog('info', '-', `Artifacts saved to ${artifacts.sessionDir}`);
      }
    }

    if (recordId) {
      services.sourceRepository.addMany(recordId, result.sources);
      await archiveResearchResultSafe({
        researchId: recordId,
        query,
        strategy: settings.research.strategy,
        result,
        artifacts,
        settings,
      }, {
        onWarning: (message) => {
          if (!flags.json) {
            onProgressLog('warn', '-', `Intel store archive failed: ${message}`);
          }
        },
      });
      services.researchRepository.updateStatus(recordId, 'completed', {
        report: result.report,
        quality: result.quality,
        completedAt: new Date().toISOString(),
      });
    }

    if (!flags.json) {
      for (const hint of collectManualImportHints({
        gaps: result.gaps || [],
        readiness: result.readiness || result.quality?.readiness || null,
        findings: result.findings || [],
        corpusDirs: settings.search?.local?.dirs || [],
      })) {
        onProgressLog('info', '-', hint);
      }
    }

    if (flags.output) {
      writeFile(flags.output, result.report, 'utf8');
    }

    recorder?.finalize?.('completed', {
      artifacts: artifacts ? {
        reportPath: artifacts.reportPath,
        findingsPath: artifacts.findingsPath,
        sourcesPath: artifacts.sourcesPath,
        metaPath: artifacts.metaPath,
      } : null,
    });
    return { result, artifacts };
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      recorder?.finalize?.('cancelled', { error });
      if (recordId) {
        services.researchRepository.updateStatus(recordId, 'cancelled', {
          error: error.message || 'Research cancelled.',
          completedAt: new Date().toISOString(),
        });
      }
      throw new ResearchCancelledError(error.message || 'Research cancelled.');
    }

    recorder?.finalize?.('failed', { error });
    if (recordId) {
      services.researchRepository.updateStatus(recordId, 'failed', {
        error: error.message,
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
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

  try {
    if (!flags['no-save'] && runId) {
      recordId = runId;
      const existing = services.researchRepository.get(recordId);
      if (!existing) {
        services.researchRepository.create({
          id: recordId,
          query,
          strategy,
        });
      }
      services.researchRepository.updateStatus(recordId, 'running', {
        error: null,
        sessionDir: resolvedSessionDir,
        completedAt: null,
      });
    }

    recorder = createRecorder(resolvedSessionDir);
    const exploreFlags = resumeExplore || parseResumeExploreFlags(flags);
    const resumePlan = selectResearchResumePlan({
      sessionDir: resolvedSessionDir,
      continueExplore: exploreFlags.continueExplore,
      extraSteps: exploreFlags.extraSteps,
    });
    if (isReportResumeMode(resumePlan.mode)) {
      onProgressLog('info', '-', `Resuming report phase from ${resolvedSessionDir}`);
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

    const artifacts = saveArtifacts({
      sessionDir: resolvedSessionDir,
      settings,
      strategy,
      query,
      result,
      researchId: recordId || undefined,
    });
    if (!flags.json) {
      onProgressLog('info', '-', `Artifacts saved to ${artifacts.sessionDir}`);
    }

    if (recordId) {
      services.sourceRepository.addMany(recordId, result.sources);
      await archiveResearchResultSafe({
        researchId: recordId,
        query,
        strategy,
        result,
        artifacts,
        settings,
      }, {
        onWarning: (message) => {
          if (!flags.json) {
            onProgressLog('warn', '-', `Intel store archive failed: ${message}`);
          }
        },
      });
      services.researchRepository.updateStatus(recordId, 'completed', {
        report: result.report,
        quality: result.quality,
        error: null,
        completedAt: new Date().toISOString(),
      });
    }

    if (!flags.json) {
      for (const hint of collectManualImportHints({
        gaps: result.gaps || [],
        readiness: result.readiness || result.quality?.readiness || null,
        findings: result.findings || [],
        corpusDirs: settings.search?.local?.dirs || [],
      })) {
        onProgressLog('info', '-', hint);
      }
    }

    if (flags.output) {
      writeFile(flags.output, result.report, 'utf8');
    }

    recorder?.finalize?.('completed', {
      artifacts: artifacts ? {
        reportPath: artifacts.reportPath,
        findingsPath: artifacts.findingsPath,
        sourcesPath: artifacts.sourcesPath,
        metaPath: artifacts.metaPath,
      } : null,
    });
    return { result, artifacts };
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      recorder?.finalize?.('cancelled', { error });
      if (recordId) {
        services.researchRepository.updateStatus(recordId, 'cancelled', {
          error: error.message || 'Research cancelled.',
          completedAt: new Date().toISOString(),
        });
      }
      throw new ResearchCancelledError(error.message || 'Research cancelled.');
    }

    recorder?.finalize?.('failed', { error });
    if (recordId) {
      services.researchRepository.updateStatus(recordId, 'failed', {
        error: error.message,
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    remove();
  }
}

function defaultCryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultProgressLog(level, progress, message) {
  console.error(`[${level}] ${progress ?? '-'}% ${message}`);
}
