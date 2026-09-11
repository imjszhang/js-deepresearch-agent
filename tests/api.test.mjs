import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/api/app.mjs';
import { migrateDb } from '../src/storage/db.mjs';

async function createTestClient(t, app) {
  // Supertest reads the address immediately; explicit loopback binding must finish first.
  const server = createServer(app);
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return request(server);
}

describe('API', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  it('reads and updates settings', async (t) => {
    db = migrateDb(new Database(':memory:'));
    const app = createApp(db);
    const client = await createTestClient(t, app);

    const initial = await client.get('/api/settings').expect(200);
    assert.equal(initial.body.llm.provider, 'openai-compatible');

    const updated = await client
      .put('/api/settings')
      .send({ llm: { provider: 'ollama', model: 'qwen' } })
      .expect(200);

    assert.equal(updated.body.llm.provider, 'ollama');
    assert.equal(updated.body.llm.model, 'qwen');
  });

  it('validates research submission', async (t) => {
    db = migrateDb(new Database(':memory:'));
    const app = createApp(db);
    const client = await createTestClient(t, app);

    const response = await client
      .post('/api/research')
      .send({ query: '' })
      .expect(400);

    assert.equal(response.body.error, 'Query is required.');
  });
});

describe('canonical committed result API', () => {
  it('reads the committed registry after pointer publication fails and fails closed on missing evidence', async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { EvidenceStore, saveResearchArtifacts } = await import('js-deepresearch-engine');
    const { ResultCommitService } = await import('../src/storage/result-commit-service.mjs');
    const db = migrateDb(new Database(':memory:'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-api-evidence-'));
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const app = createApp(db);
    const client = await createTestClient(t, app);
    const services = app.locals.services;
    services.researchRepository.create({ id: 'run', query: 'query', strategy: 'focused' });
    services.researchRepository.updateStatus('run', 'running', { sessionDir: dir });
    const store = new EvidenceStore();
    const version = store.register({ url: 'https://example.org/tool', content: 'The tool supports local document processing according to its publisher.', fetchStatus: 'ok' });
    const passage = store.chunks(version.documentVersionId)[0];
    const result = { resultRevision: 'new', report: '# Committed [9.1]', findings: [], sources: [{ id: version.sourceId, url: version.url }], quality: { gate: 'pass' },
      evidenceStore: store.export(), evidenceAppendix: '# Committed evidence', citationRegistry: { schemaVersion: 1, entries: [{ citationKey: '9.1', sourceId: version.sourceId, documentVersionId: version.documentVersionId, passageIds: [passage.id], url: version.url }] } };
    saveResearchArtifacts({ sessionDir: dir, query: 'old', strategy: 'quick', settings: {}, result: { resultRevision: 'old', report: '# Old', findings: [], sources: [] } });
    const artifacts = saveResearchArtifacts({ sessionDir: dir, query: 'query', strategy: 'focused', settings: {}, result, publish: false });
    new ResultCommitService({ db, ...services }).commit('run', result, artifacts);
    const response = await client.get('/api/research/run').expect(200);
    assert.equal(response.body.report, '# Committed [9.1]');
    assert.equal(response.body.citationRegistry.entries[0].citationKey, '9.1');
    assert.equal((await client.get(response.body.evidenceUrl).expect(200)).text, '# Committed evidence');
    fs.unlinkSync(path.join(artifacts.resultDir, version.bodyRef));
    assert.equal((await client.get('/api/research/run').expect(503)).body.code, 'RESULT_INTEGRITY');
  });
  it('rejects planning context authority fields before queuing research', async (t) => {
    const db = migrateDb(new Database(':memory:'));
    try {
      const app = createApp(db);
      const client = await createTestClient(t, app);
      await client.post('/api/research').send({ query: 'Tool', planningContext: { requiredHosts: ['example.org'] } }).expect(400);
      assert.equal(app.locals.services.researchRepository.list().length, 0);
    } finally { db.close(); }
  });
});
