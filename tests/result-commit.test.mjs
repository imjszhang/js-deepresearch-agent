import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrateDb } from '../src/storage/db.mjs';
import { ResearchRepository } from '../src/storage/research-repository.mjs';
import { SourceRepository } from '../src/storage/source-repository.mjs';
import { ResultCommitService } from '../src/storage/result-commit-service.mjs';

test('result snapshots preserve IDs, update order and fields, and roll back together', () => {
  const db = migrateDb(new Database(':memory:'));
  try {
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    const service = new ResultCommitService({ db, researchRepository, sourceRepository });
    researchRepository.create({ id: 'one', query: 'q', strategy: 'quick' });
    const a = { url: 'https://example.com/a', title: 'a' };
    const b = { url: 'https://example.com/b?version=1', title: 'b' };
    const c = { url: 'https://example.com/b?version=2', title: 'c' };
    const save = (sources, report = '# Report') => service.commit('one', { sources, report, quality: { gate: 'pass' } });
    save([a, b]);
    const idB = sourceRepository.list('one')[1].id;
    save([{ ...b, title: 'updated' }, c]);
    save([{ ...b, title: 'updated' }, c]);
    assert.deepEqual(sourceRepository.list('one').map((s) => s.url), [b.url, c.url]);
    assert.equal(sourceRepository.list('one')[0].id, idB);
    assert.equal(sourceRepository.list('one')[0].title, 'updated');
    db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON research_history BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");
    assert.throws(() => save([a], '# Bad'), /injected commit failure/);
    assert.deepEqual(sourceRepository.list('one').map((s) => s.url), [b.url, c.url]);
    assert.equal(researchRepository.get('one').report, '# Report');
  } finally { db.close(); }
});

test('legacy source migration retains oldest ID, latest values and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY, research_id TEXT, title TEXT, url TEXT, snippet TEXT, engine TEXT, created_at TEXT);
      INSERT INTO sources VALUES(1,'one','old','https://a','','','old');
      INSERT INTO sources VALUES(2,'one','new','https://a','','','new');
      INSERT INTO sources VALUES(3,'two','other','https://a','','','other');`);
    migrateDb(db);
    migrateDb(db);
    const rows = db.prepare('SELECT * FROM sources ORDER BY id').all();
    assert.deepEqual(rows.map((row) => [row.id, row.title]), [[1, 'new'], [3, 'other']]);
    assert.throws(() => db.prepare('INSERT INTO sources(research_id,source_key) VALUES(?,?)').run('one', rows[0].source_key), /UNIQUE/);
  } finally { db.close(); }
});
