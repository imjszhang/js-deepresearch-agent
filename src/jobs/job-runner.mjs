import crypto from 'node:crypto';
import {
  FileRunRecorder,
  ResearchRunner,
  createWorkSessionDir,
  saveResearchArtifacts,
  normalizePlanningContext,
} from 'js-deepresearch-engine';
import { completeResearch, recordResearchFailure } from '../research-completion.mjs';
import { acquireSessionLock } from '../session-lock.mjs';

export class JobRunner {
  constructor({ settingsStore, researchRepository, logRepository, sourceRepository, eventBus, resultCommitService }) {
    this.resultCommitService = resultCommitService;
    this.settingsStore = settingsStore;
    this.researchRepository = researchRepository;
    this.logRepository = logRepository;
    this.sourceRepository = sourceRepository;
    this.eventBus = eventBus;
    this.activeJobs = new Map();
    this.runner = new ResearchRunner();
  }

  start({ query, planningContext, overrides = {} }) {
    planningContext = normalizePlanningContext(planningContext);
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
      planningContext,
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
    planningContext,
    settings,
    controller,
    sessionDir: providedSessionDir,
    recorder: providedRecorder,
  }) {
    let recorder = providedRecorder || null;
    let releaseLock = null;
    try {
      const sessionDir = providedSessionDir || createWorkSessionDir({
        settings,
        strategy: settings.research.strategy,
      });
      releaseLock = acquireSessionLock(sessionDir);
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
        planningContext,
        settings,
        signal: controller.signal,
        recorder,
        onProgress: (event) => this.emitLog(id, event),
      });
      await completeResearch({
        id, result, query, strategy: settings.research.strategy, settings, sessionDir, recorder,
        services: this, saveArtifacts: saveResearchArtifacts, signal: controller.signal,
        onWarning: ({ stage, code }) => this.emitLog(id, { level: 'warn', message: `Delivery ${stage} failed (${code}); research result retained.` }),
        onStatus: (record) => this.eventBus.emit(id, { type: 'status', data: record }),
      });
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      recordResearchFailure({ recorder, repository: this.researchRepository, id, error, cancelled: status === 'cancelled' });
      this.emitLog(id, { level: 'error', message: error.message, progress: null });
      try { this.eventBus.emit(id, { type: 'status', data: this.researchRepository.get?.(id) }); } catch { /* best effort */ }
    } finally {
      releaseLock?.();
      this.activeJobs.delete(id);
    }
  }

  emitLog(id, { level = 'info', message, progress = null }) {
    try {
      const log = this.logRepository.add(id, { level, message, progress });
      this.eventBus.emit(id, { type: 'log', data: log });
    } catch { /* logging must not stop a running or committed research */ }
  }
}
