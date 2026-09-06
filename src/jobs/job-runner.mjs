import crypto from 'node:crypto';
import {
  FileRunRecorder,
  ResearchRunner,
  createWorkSessionDir,
  saveResearchArtifacts,
} from 'js-deepresearch-engine';
import { archiveResearchResultSafe } from '../storage/intel-store.mjs';

export class JobRunner {
  constructor({ settingsStore, researchRepository, logRepository, sourceRepository, eventBus }) {
    this.settingsStore = settingsStore;
    this.researchRepository = researchRepository;
    this.logRepository = logRepository;
    this.sourceRepository = sourceRepository;
    this.eventBus = eventBus;
    this.activeJobs = new Map();
    this.runner = new ResearchRunner();
  }

  start({ query, overrides = {} }) {
    const settings = this.settingsStore.snapshot(overrides);
    const id = crypto.randomUUID();
    this.researchRepository.create({
      id,
      query,
      strategy: settings.research.strategy,
    });

    let sessionDir;
    let recorder;
    try {
      sessionDir = createWorkSessionDir({
        settings,
        strategy: settings.research.strategy,
      });
      recorder = new FileRunRecorder({
        sessionDir,
        runId: id,
        strategy: settings.research.strategy,
        query,
        metadata: { settings },
      });
    } catch (error) {
      this.researchRepository.updateStatus(id, 'failed', {
        error: error.message,
        sessionDir: sessionDir || null,
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
    const controller = new AbortController();
    this.activeJobs.set(id, controller);
    queueMicrotask(() => this.runJob({
      id,
      query,
      settings,
      controller,
      sessionDir,
      recorder,
    }));

    return this.researchRepository.updateStatus(id, 'running', { sessionDir });
  }

  cancel(id) {
    const controller = this.activeJobs.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runJob({
    id,
    query,
    settings,
    controller,
    sessionDir: providedSessionDir,
    recorder: providedRecorder,
  }) {
    let recorder = providedRecorder || null;
    try {
      const sessionDir = providedSessionDir || createWorkSessionDir({
        settings,
        strategy: settings.research.strategy,
      });
      if (!recorder) {
        recorder = new FileRunRecorder({
          sessionDir,
          runId: id,
          strategy: settings.research.strategy,
          query,
          metadata: { settings },
        });
        this.researchRepository.updateStatus(id, 'running', { sessionDir });
      }
      this.emitLog(id, { message: 'Job started', progress: 1 });
      const result = await this.runner.run({
        query,
        settings,
        signal: controller.signal,
        recorder,
        onProgress: (event) => this.emitLog(id, event),
      });
      const budget = result.quality?.budget?.usage || {};
      const qualityMetrics = result.quality?.metrics || {};
      this.emitLog(id, {
        message: `Quality: ${result.quality?.gate || 'unknown'}; key-supported=${formatRate(qualityMetrics.rates?.keyClaimSupportedRate)}; direct-evidence=${formatRate(qualityMetrics.rates?.directEvidenceRate)}; gaps=${result.gaps?.filter((gap) => gap.status === 'resolved').length || 0}/${result.gaps?.length || 0}; searches=${budget.searchRequests || 0}; reads=${budget.sourceReads || 0}`,
        progress: 99,
      });

      this.sourceRepository.addMany(id, result.sources);
      const artifacts = saveResearchArtifacts({
        sessionDir,
        settings,
        strategy: settings.research.strategy,
        query,
        result,
        researchId: id,
      });
      await archiveResearchResultSafe({
        researchId: id,
        query,
        strategy: settings.research.strategy,
        result,
        artifacts,
        settings,
      }, {
        onWarning: (message) => {
          this.emitLog(id, { level: 'warn', message: `Intel store archive failed: ${message}`, progress: null });
        },
      });
      const record = this.researchRepository.updateStatus(id, 'completed', {
        report: result.report,
        quality: result.quality,
        completedAt: new Date().toISOString(),
      });
      recorder.finalize('completed', {
        artifacts: {
          reportPath: artifacts.reportPath,
          findingsPath: artifacts.findingsPath,
          sourcesPath: artifacts.sourcesPath,
          metaPath: artifacts.metaPath,
        },
      });
      this.eventBus.emit(id, { type: 'status', data: record });
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      recorder?.finalize?.(status, { error });
      const record = this.researchRepository.updateStatus(id, status, {
        error: error.message,
        completedAt: new Date().toISOString(),
      });
      this.emitLog(id, { level: 'error', message: error.message, progress: null });
      this.eventBus.emit(id, { type: 'status', data: record });
    } finally {
      this.activeJobs.delete(id);
    }
  }

  emitLog(id, { level = 'info', message, progress = null }) {
    const log = this.logRepository.add(id, { level, message, progress });
    this.eventBus.emit(id, { type: 'log', data: log });
  }
}

function formatRate(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}
