import './search-providers/register-local-search-engines.mjs';
import { SettingsStore } from './config/settings-store.mjs';
import { ResearchEventBus } from './jobs/event-bus.mjs';
import { JobRunner } from './jobs/job-runner.mjs';
import { LogRepository } from './storage/log-repository.mjs';
import { ResearchRepository } from './storage/research-repository.mjs';
import { SourceRepository } from './storage/source-repository.mjs';

export function createServices(db) {
  const settingsStore = new SettingsStore(db);
  const researchRepository = new ResearchRepository(db);
  const logRepository = new LogRepository(db);
  const sourceRepository = new SourceRepository(db);
  const eventBus = new ResearchEventBus();
  const jobRunner = new JobRunner({
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
  });

  return {
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
    jobRunner,
  };
}
