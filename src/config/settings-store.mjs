import { defaultSettings, mergeSettings } from './defaults.mjs';

const SETTINGS_KEY = 'app';

export class SettingsStore {
  constructor(db) {
    this.db = db;
  }

  get() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
    if (!row) {
      return mergeSettings();
    }

    try {
      return mergeSettings(JSON.parse(row.value));
    } catch {
      return mergeSettings();
    }
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
}
