import { defaultSettings, mergeSettings } from './defaults.mjs';
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

    return mergeSettings(this.withEnvOverrides(stored));
  }

  save(settings) {
    const merged = mergeSettings(settings);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(merged), now);
    return merged;
  }

  snapshot(overrides = {}) {
    const current = this.get();
    return mergeSettings({
      ...current,
      ...overrides,
      llm: { ...current.llm, ...(overrides.llm || {}) },
      search: { ...current.search, ...(overrides.search || {}) },
      research: { ...current.research, ...(overrides.research || {}) },
    });
  }

  reset() {
    return this.save(defaultSettings);
  }

  withEnvOverrides(stored = {}) {
    const envOverrides = settingsFromEnv();

    return {
      ...stored,
      llm: { ...(stored.llm || {}), ...(envOverrides.llm || {}) },
      search: { ...(stored.search || {}), ...(envOverrides.search || {}) },
      research: { ...(stored.research || {}), ...(envOverrides.research || {}) },
    };
  }
}
