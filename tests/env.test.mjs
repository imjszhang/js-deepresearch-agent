import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { settingsFromEnv } from '../src/config/env-overrides.mjs';
import { loadEnv } from '../src/config/load-env.mjs';
import { SettingsStore } from '../src/config/settings-store.mjs';
import { migrateDb } from '../src/storage/db.mjs';
import Database from 'better-sqlite3';

describe('environment configuration', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('loads .env values into process.env without overriding existing vars', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-env-'));
    fs.writeFileSync(path.join(tempDir, '.env'), `
# comment
SEARCH_BASE_URL=http://env-search.local
SEARCH_ENGINE=searxng
EXISTING=from-file
`);

    process.env.EXISTING = 'from-shell';
    loadEnv(tempDir);

    assert.equal(process.env.SEARCH_BASE_URL, 'http://env-search.local');
    assert.equal(process.env.SEARCH_ENGINE, 'searxng');
    assert.equal(process.env.EXISTING, 'from-shell');

    delete process.env.SEARCH_BASE_URL;
    delete process.env.SEARCH_ENGINE;
    delete process.env.EXISTING;
  });

  it('maps search env vars to settings overrides', () => {
    const overrides = settingsFromEnv({
      SEARCH_ENGINE: 'searxng',
      SEARCH_BASE_URL: 'http://192.168.31.82:8889',
      SEARCH_API_KEY: 'search-key',
      SEARXNG_URL: 'http://legacy.local',
    });

    assert.equal(overrides.search.engine, 'searxng');
    assert.equal(overrides.search.baseUrl, 'http://192.168.31.82:8889');
    assert.equal(overrides.search.apiKey, 'search-key');
  });

  it('applies env overrides when reading settings from the store', () => {
    const db = migrateDb(new Database(':memory:'));
    const store = new SettingsStore(db);

    store.save({
      search: {
        engine: 'searxng',
        baseUrl: 'http://127.0.0.1:8080',
      },
    });

    process.env.SEARCH_BASE_URL = 'http://192.168.31.82:8889';
    try {
      const settings = store.get();
      assert.equal(settings.search.baseUrl, 'http://192.168.31.82:8889');
    } finally {
      delete process.env.SEARCH_BASE_URL;
    }

    db.close();
  });
});
