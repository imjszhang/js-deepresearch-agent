import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/api/app.mjs';
import { migrateDb } from '../src/storage/db.mjs';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';

describe('API wiki and intel', () => {
  let db;
  const tempDirs = [];
  let previousIntelDir;

  afterEach(() => {
    db?.close();
    resetIntelStoreEngine();
    if (previousIntelDir === undefined) {
      delete process.env.JDR_INTEL_STORE_DIR;
    } else {
      process.env.JDR_INTEL_STORE_DIR = previousIntelDir;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createTestApp(t, { intelDir, wikiDir } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-api-wiki-'));
    tempDirs.push(root);
    const resolvedIntel = intelDir || path.join(root, 'intel');
    const resolvedWiki = wikiDir || path.join(root, 'wiki');

    previousIntelDir = process.env.JDR_INTEL_STORE_DIR;
    process.env.JDR_INTEL_STORE_DIR = resolvedIntel;
    resetIntelStoreEngine();

    db = migrateDb(new Database(':memory:'));
    const app = createApp(db);
    const settings = app.locals.services.settingsStore.get();
    app.locals.services.settingsStore.save({
      ...settings,
      research: { ...settings.research, wikiVault: resolvedWiki },
    });

    const engine = createIntelStoreEngine({ baseDir: resolvedIntel });
    // Supertest reads the address immediately; explicit loopback binding must finish first.
    const server = createServer(app);
    t.after(async () => {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return { app, client: request(server), engine, wikiDir: resolvedWiki, root };
  }

  it('lists intel runs', async (t) => {
    const { client, engine } = await createTestApp(t);
    archiveResearchResult({
      researchId: 'api-wiki-run',
      query: 'llm wiki',
      strategy: 'source-based',
      result: {
        report: '# Report\n\n## Summary\n\n- LLM Wiki compiles research into markdown pages with references [1.1]\n',
        findings: [],
        sources: [{ title: 'Source A', url: 'https://example.com/a', snippet: 'alpha' }],
      },
      engine,
    });

    const response = await client.get('/api/intel/runs?limit=10').expect(200);
    assert.equal(response.body.runs.length, 1);
    assert.equal(response.body.runs[0].researchId, 'api-wiki-run');
    assert.ok(response.body.vaultDir);
  });

  it('compiles wiki and answers questions', async (t) => {
    const { client, engine, wikiDir } = await createTestApp(t);
    archiveResearchResult({
      researchId: 'api-wiki-compile',
      query: 'llm wiki',
      strategy: 'source-based',
      result: {
        report: '# Report\n\n## Summary\n\n- Karpathy LLM Wiki uses ingest query and lint for knowledge [1.1]\n',
        findings: [],
        sources: [{ title: 'LLM Wiki', url: 'https://example.com/wiki', snippet: 'LLM Wiki knowledge base' }],
      },
      engine,
    });

    const compiled = await client
      .post('/api/wiki/compile')
      .send({ researchId: 'api-wiki-compile', lint: true })
      .expect(200);

    assert.equal(compiled.body.compiled, 1);
    assert.equal(compiled.body.lint.errorCount, 0);
    assert.ok(fs.existsSync(path.join(wikiDir, 'Home.md')));

    const status = await client.get('/api/wiki/status').expect(200);
    assert.equal(status.body.homeExists, true);
    assert.ok(status.body.manifest.compiledAt);

    const ask = await client
      .post('/api/wiki/ask')
      .send({ question: 'LLM Wiki', limit: 5 })
      .expect(200);

    assert.equal(ask.body.mode, 'retrieval');
    assert.ok(ask.body.pages.length > 0);

    const pages = await client.get('/api/wiki/pages').expect(200);
    assert.ok(pages.body.pages.length >= 1);

    const home = await client.get('/api/wiki/page?path=Home.md').expect(200);
    assert.match(home.body.markdown, /LLM Wiki/i);

    const topic = await client
      .get('/api/wiki/page?path=Topics/Llm%20Wiki.md')
      .expect(200);
    assert.ok(topic.body.links.length >= 0);
  });

  it('returns 404 when researchId is missing from intel store', async (t) => {
    const { client } = await createTestApp(t);
    const response = await client
      .post('/api/wiki/compile')
      .send({ researchId: 'missing-id' })
      .expect(404);

    assert.match(response.body.error, /not found/i);
  });
});
