import crypto from 'node:crypto';
import { ResearchRunner, saveResearchToWorkDir } from 'js-deepresearch-engine';
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

    const controller = new AbortController();
    this.activeJobs.set(id, controller);
    queueMicrotask(() => this.runJob({ id, query, settings, controller }));

    return this.researchRepository.updateStatus(id, 'running');
  }

  cancel(id) {
    const controller = this.activeJobs.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runJob({ id, query, settings, controller }) {
    try {
      this.emitLog(id, { message: 'Job started', progress: 1 });
      const result = await this.runner.run({
        query,
        settings,
        signal: controller.signal,
        onProgress: (event) => this.emitLog(id, event),
      });

      this.sourceRepository.addMany(id, result.sources);
      const artifacts = saveResearchToWorkDir({
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
        completedAt: new Date().toISOString(),
      });
      this.eventBus.emit(id, { type: 'status', data: record });
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
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
