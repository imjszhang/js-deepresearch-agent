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

  it('maps SEARCH_LOCAL_DIRS and JDR_CORPUS_DIRS onto search.local.dirs', () => {
    const fromSearch = settingsFromEnv({
      SEARCH_LOCAL_DIRS: '/tmp/notes,/tmp/reports,/tmp/notes',
    });
    assert.equal(fromSearch.search.engine, 'local');
    assert.deepEqual(fromSearch.search.local.dirs, ['/tmp/notes', '/tmp/reports']);

    const fromAlias = settingsFromEnv({
      SEARCH_ENGINE: 'searxng',
      JDR_CORPUS_DIRS: '/tmp/alias',
    });
    assert.equal(fromAlias.search.engine, 'searxng');
    assert.deepEqual(fromAlias.search.local.dirs, ['/tmp/alias']);
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

  it('maps SEARCH_LANGUAGE, SEARCH_ENGINES, and JDR_SOURCE_ASSESSMENT', () => {
    const overrides = settingsFromEnv({
      SEARCH_LANGUAGE: 'zh',
      SEARCH_ENGINES: 'brave,google',
      SEARCH_CATEGORIES: 'general',
      JDR_SOURCE_ASSESSMENT: 'true',
    });
    assert.equal(overrides.search.language, 'zh');
    assert.equal(overrides.search.options.engines, 'brave,google');
    assert.equal(overrides.search.options.categories, 'general');
    assert.equal(overrides.research.read.sourceAssessment.enabled, true);
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
      JS_EYES_MIN_INTERVAL_MS: '1500',
      JS_EYES_MAX_RETRIES: '2',
    });

    assert.equal(overrides.search.engine, 'js-eyes');
    assert.equal(overrides.search.jsEyesCli, 'custom-js-eyes');
    assert.equal(overrides.search.jsEyesSkill, 'js-xiaohongshu-ops-skill');
    assert.deepEqual(overrides.search.jsEyesSkills, ['js-xiaohongshu-ops-skill']);
    assert.equal(overrides.search.jsEyesCommand, 'search');
    assert.equal(overrides.search.jsEyesServerUrl, 'ws://127.0.0.1:18080');
    assert.equal(overrides.search.jsEyesMaxPages, 3);
    assert.equal(overrides.search.jsEyesTimeoutMs, 45000);
    assert.equal(overrides.search.jsEyesMinIntervalMs, 1500);
    assert.equal(overrides.search.jsEyesMaxRetries, 2);
    assert.equal(overrides.search.provider.minIntervalMs, 1500);
    assert.equal(overrides.search.provider.maxRetries, 2);
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

  it('maps relevance admission overrides without enabling a rerank provider', () => {
    const settings = settingsFromEnv({
      JDR_RELEVANCE_ENABLED: 'true',
      JDR_RELEVANCE_MIN_RERANK_SCORE: '0.07',
      JDR_BODY_RELEVANCE_ENABLED: 'false',
      JDR_SITE_QUERY_MODE: 'confirmed',
      JDR_MAX_REPAIR_FAILURES_PER_GAP: '3',
      JDR_MAX_CONSECUTIVE_INVALID_STEPS: '6',
      JINA_API_KEY: 'key-only',
    });
    assert.deepEqual(settings.research.read.relevance, {
      enabled: true,
      minRerankScore: 0.07,
      bodyValidation: false,
      siteQueryMode: 'confirmed',
    });
    assert.equal(settings.research.exploratory.maxRepairFailuresPerGap, 3);
    assert.equal(settings.research.exploratory.maxConsecutiveInvalidSteps, 6);
    assert.equal(settings.research.providers.rerank.provider, undefined);
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

  it('rewrites persisted research strategy IDs and nested keys once', () => {
    const db = migrateDb(new Database(':memory:'));
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run('app', JSON.stringify({
      research: {
        strategy: 'source-based',
        sourceBased: {
          fetchMode: 'full',
          adaptiveControl: { enabled: false },
        },
        adaptive: { loopVersion: 'v2', maxSteps: 7 },
      },
    }), now);

    const store = new SettingsStore(db);
    const settings = store.get();
    assert.equal(settings.research.strategy, 'focused');
    assert.equal(settings.research.focused.fetchMode, 'full');
    assert.equal(settings.research.focused.iterationControl.enabled, false);
    assert.equal(settings.research.exploratory.maxSteps, 7);
    assert.equal(settings.research.sourceBased, undefined);
    assert.equal(settings.research.adaptive, undefined);

    const stored = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('app').value);
    assert.equal(stored.research.strategy, 'focused');
    assert.equal(stored.research.sourceBased, undefined);
    assert.equal(stored.research.adaptive, undefined);

    db.close();
  });
});
