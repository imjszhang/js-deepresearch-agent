import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/api/app.mjs';
import { migrateDb } from '../src/storage/db.mjs';

describe('API', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  it('reads and updates settings', async () => {
    db = migrateDb(new Database(':memory:'));
    const app = createApp(db);

    const initial = await request(app).get('/api/settings').expect(200);
    assert.equal(initial.body.llm.provider, 'openai-compatible');

    const updated = await request(app)
      .put('/api/settings')
      .send({ llm: { provider: 'ollama', model: 'qwen' } })
      .expect(200);

    assert.equal(updated.body.llm.provider, 'ollama');
    assert.equal(updated.body.llm.model, 'qwen');
  });

  it('validates research submission', async () => {
    db = migrateDb(new Database(':memory:'));
    const app = createApp(db);

    const response = await request(app)
      .post('/api/research')
      .send({ query: '' })
      .expect(400);

    assert.equal(response.body.error, 'Query is required.');
  });
});
