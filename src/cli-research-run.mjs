import fs from 'node:fs';
import {
  FileRunRecorder,
  ResearchRunner,
  createWorkSessionDir,
  saveResearchArtifacts,
} from 'js-deepresearch-engine';
import { archiveResearchResultSafe } from './storage/intel-store.mjs';

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
