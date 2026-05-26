import fs from 'node:fs';
import { ResearchRunner, saveResearchToWorkDir } from 'js-deepresearch-engine';

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
  saveArtifacts = saveResearchToWorkDir,
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

  try {
    if (!flags['no-save']) {
      recordId = cryptoRandomId();
      services.researchRepository.create({
        id: recordId,
        query,
        strategy: settings.research.strategy,
      });
      services.researchRepository.updateStatus(recordId, 'running');
    }

    const result = await runner.run({
      query,
      settings,
      signal: controller.signal,
      onProgress: ({ message, progress, level }) => {
        if (!flags.json) {
          onProgressLog(level, progress, message);
        }
      },
    });

    let artifacts = null;
    if (!flags['no-work-dir']) {
      artifacts = saveArtifacts({
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
      services.researchRepository.updateStatus(recordId, 'completed', {
        report: result.report,
        completedAt: new Date().toISOString(),
      });
    }

    if (flags.output) {
      writeFile(flags.output, result.report, 'utf8');
    }

    return { result, artifacts };
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      if (recordId) {
        services.researchRepository.updateStatus(recordId, 'cancelled', {
          error: error.message || 'Research cancelled.',
          completedAt: new Date().toISOString(),
        });
      }
      throw new ResearchCancelledError(error.message || 'Research cancelled.');
    }

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
