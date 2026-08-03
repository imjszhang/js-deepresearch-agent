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
    assert.equal(overrides.search.options.jsEyesCli, 'custom-js-eyes');
    assert.deepEqual(overrides.search.options.jsEyesSkills, ['js-xiaohongshu-ops-skill']);
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

  it('maps HTTP proxy env vars to settings overrides', () => {
    const overrides = settingsFromEnv({
      JDR_HTTP_PROXY: 'socks5://127.0.0.1:1080',
    });

    assert.equal(overrides.http.proxy, 'socks5://127.0.0.1:1080');
  });

  it('applies HTTP proxy env overrides when reading settings from the store', () => {
    const db = migrateDb(new Database(':memory:'));
    const store = new SettingsStore(db);

    store.save({ llm: { model: 'gpt-4o-mini' } });

    process.env.JDR_HTTP_PROXY = 'socks5://127.0.0.1:1080';
    try {
      const settings = store.get();
      assert.equal(settings.http.proxy, 'socks5://127.0.0.1:1080');
    } finally {
      delete process.env.JDR_HTTP_PROXY;
    }

    db.close();
  });

  it('maps optional rerank settings without enabling Jina from its key alone', () => {
    const keyed = settingsFromEnv({ JINA_API_KEY: 'test-key' });
    assert.equal(keyed.research.providers.rerank.apiKey, 'test-key');
    assert.equal(keyed.research.providers.rerank.provider, undefined);

    const enabled = settingsFromEnv({
      JDR_RERANK_PROVIDER: 'jina',
      JDR_RERANK_MODEL: 'rerank-model',
      JDR_SEMANTIC_TIMEOUT_MS: '4567',
    });
    assert.equal(enabled.research.providers.rerank.provider, 'jina');
    assert.equal(enabled.research.providers.rerank.model, 'rerank-model');
    assert.equal(enabled.research.providers.rerank.timeoutMs, 4567);
  });

  it('maps optional embedding settings and falls back to OPENCLAW_GATEWAY_TOKEN', () => {
    const keyed = settingsFromEnv({ OPENCLAW_GATEWAY_TOKEN: 'gateway-token' });
    assert.equal(keyed.research.providers.embedding.apiKey, 'gateway-token');
    assert.equal(keyed.research.providers.embedding.provider, undefined);

    const enabled = settingsFromEnv({
      JDR_EMBEDDING_PROVIDER: 'openai-compatible',
      JDR_EMBEDDING_BASE_URL: 'http://127.0.0.1:18789',
      JDR_EMBEDDING_MODEL: 'openclaw/default',
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
    });
    assert.equal(enabled.research.providers.embedding.provider, 'openai-compatible');
    assert.equal(enabled.research.providers.embedding.baseUrl, 'http://127.0.0.1:18789');
    assert.equal(enabled.research.providers.embedding.model, 'openclaw/default');
    assert.equal(enabled.research.providers.embedding.apiKey, 'gateway-token');
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
