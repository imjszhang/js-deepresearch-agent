import './search-providers/register-local-search-engines.mjs';
import { SettingsStore } from './config/settings-store.mjs';
import { ResearchEventBus } from './jobs/event-bus.mjs';
import { JobRunner } from './jobs/job-runner.mjs';
import { LogRepository } from './storage/log-repository.mjs';
import { ResearchRepository } from './storage/research-repository.mjs';
import { SourceRepository } from './storage/source-repository.mjs';
import { ResultCommitService } from './storage/result-commit-service.mjs';

export function createServices(db) {
  const settingsStore = new SettingsStore(db);
  const researchRepository = new ResearchRepository(db);
  const logRepository = new LogRepository(db);
  const sourceRepository = new SourceRepository(db);
  const resultCommitService = new ResultCommitService({ db, researchRepository, sourceRepository });
  const eventBus = new ResearchEventBus();
  const jobRunner = new JobRunner({
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
    resultCommitService,
  });

  return {
    settingsStore,
    researchRepository,
    logRepository,
    sourceRepository,
    eventBus,
    jobRunner,
    resultCommitService,
  };
}
