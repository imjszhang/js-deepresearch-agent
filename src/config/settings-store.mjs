import { migrateResearchSettings, researchSettingsNeedMigration } from 'js-deepresearch-engine';
import { defaultAppSettings, mergeAppSettings } from './app-settings.mjs';
import { settingsFromEnv } from './env-overrides.mjs';

const SETTINGS_KEY = 'app';

export class SettingsStore {
  constructor(db) {
    this.db = db;
  }

  get() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
    let stored = {};

    if (row) {
      try {
        stored = JSON.parse(row.value);
      } catch {
        stored = {};
      }
    }

    if (researchSettingsNeedMigration(stored.research)) {
      stored = {
        ...stored,
        research: migrateResearchSettings(stored.research || {}),
      };
      this.persist(mergeAppSettings(stored));
    }

    return mergeAppSettings(this.withEnvOverrides(stored));
  }

  persist(settings) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(settings), now);
    return settings;
  }

  save(settings) {
    return this.persist(mergeAppSettings(settings));
  }

  snapshot(overrides = {}) {
    const current = this.get();
    return mergeAppSettings({
      ...current,
      ...overrides,
      http: { ...current.http, ...(overrides.http || {}) },
      llm: { ...current.llm, ...(overrides.llm || {}) },
      search: {
        ...current.search,
        ...(overrides.search || {}),
        local: {
          ...(current.search?.local || {}),
          ...(overrides.search?.local || {}),
        },
      },
      research: { ...current.research, ...(overrides.research || {}) },
    });
  }

  reset() {
    return this.save(defaultAppSettings);
  }

  withEnvOverrides(stored = {}) {
    const envOverrides = settingsFromEnv();
    const storedResearch = stored.research || {};
    const envResearch = envOverrides.research || {};
    const storedProviders = storedResearch.providers || {};
    const envProviders = envResearch.providers || {};

    return {
      ...stored,
      http: { ...(stored.http || {}), ...(envOverrides.http || {}) },
      llm: { ...(stored.llm || {}), ...(envOverrides.llm || {}) },
      search: {
        ...(stored.search || {}),
        ...(envOverrides.search || {}),
        local: {
          ...((stored.search || {}).local || {}),
          ...((envOverrides.search || {}).local || {}),
        },
      },
      research: {
        ...storedResearch,
        ...envResearch,
        providers: {
          ...storedProviders,
          ...envProviders,
          embedding: { ...(storedProviders.embedding || {}), ...(envProviders.embedding || {}) },
          rerank: { ...(storedProviders.rerank || {}), ...(envProviders.rerank || {}) },
        },
      },
    };
  }
}
