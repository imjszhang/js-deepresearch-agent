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

  it('maps JS Eyes env vars to settings overrides', () => {
    const overrides = settingsFromEnv({
      SEARCH_ENGINE: 'js-eyes',
      JS_EYES_CLI: 'custom-js-eyes',
      JS_EYES_SKILL: 'js-xiaohongshu-ops-skill',
      JS_EYES_COMMAND: 'search',
      JS_EYES_SERVER_URL: 'ws://127.0.0.1:18080',
      JS_EYES_MAX_PAGES: '3',
      JS_EYES_TIMEOUT_MS: '45000',
    });

    assert.equal(overrides.search.engine, 'js-eyes');
    assert.equal(overrides.search.jsEyesCli, 'custom-js-eyes');
    assert.equal(overrides.search.jsEyesSkill, 'js-xiaohongshu-ops-skill');
    assert.deepEqual(overrides.search.jsEyesSkills, ['js-xiaohongshu-ops-skill']);
    assert.equal(overrides.search.jsEyesCommand, 'search');
    assert.equal(overrides.search.jsEyesServerUrl, 'ws://127.0.0.1:18080');
    assert.equal(overrides.search.jsEyesMaxPages, 3);
    assert.equal(overrides.search.jsEyesTimeoutMs, 45000);
  });

  it('maps comma-separated JS Eyes skills to an array', () => {
    const overrides = settingsFromEnv({
      JS_EYES_SKILL: 'js-zhihu-ops-skill,js-xiaohongshu-ops-skill',
    });

    assert.equal(overrides.search.jsEyesSkill, 'js-zhihu-ops-skill');
    assert.deepEqual(overrides.search.jsEyesSkills, [
      'js-zhihu-ops-skill',
      'js-xiaohongshu-ops-skill',
    ]);
  });

  it('normalizes whitespace and duplicate JS Eyes skills', () => {
    const overrides = settingsFromEnv({
      JS_EYES_SKILL: ' a , a ; b ',
    });

    assert.deepEqual(overrides.search.jsEyesSkills, ['a', 'b']);
    assert.equal(overrides.search.jsEyesSkill, 'a');
  });

  it('maps llm env vars to settings overrides', () => {
    const overrides = settingsFromEnv({
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'qwen2.5:7b',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    });

    assert.equal(overrides.llm.provider, 'ollama');
    assert.equal(overrides.llm.model, 'qwen2.5:7b');
    assert.equal(overrides.llm.baseUrl, 'http://127.0.0.1:11434');
  });

  it('maps work directory env vars to settings overrides', () => {
    const overrides = settingsFromEnv({
      WORK_DIR: '/tmp/custom-work',
    });

    assert.equal(overrides.research.workDir, '/tmp/custom-work');
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
