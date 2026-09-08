import { sourceSnapshot } from './source-key.mjs';

export class SourceRepository {
  constructor(db) {
    this.db = db;
  }

  addMany(researchId, sources) {
    const insert = this.db.prepare(`
      INSERT INTO sources (research_id, title, url, snippet, engine, created_at, source_key, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(research_id, source_key) DO UPDATE SET
        title=excluded.title, url=excluded.url, snippet=excluded.snippet,
        engine=excluded.engine, position=excluded.position
    `);
    const now = new Date().toISOString();
    const transaction = this.db.transaction((items) => {
      for (const { source, key, position } of items) {
        insert.run(
          researchId,
          source.title || '',
          source.url || '',
          source.snippet || '',
          source.engine || '',
          now,
          key,
          position,
        );
      }
    });
    transaction(sourceSnapshot(sources));
  }

  replaceForResearch(researchId, sources) {
    this.db.transaction(() => {
      const keys = new Set(sourceSnapshot(sources).map((entry) => entry.key));
      for (const row of this.db.prepare('SELECT id, source_key FROM sources WHERE research_id=?').all(researchId)) {
        if (!keys.has(row.source_key)) this.db.prepare('DELETE FROM sources WHERE id=?').run(row.id);
      }
      this.addMany(researchId, sources);
    })();
  }

  list(researchId) {
    return this.db.prepare(`
      SELECT id, research_id, title, url, snippet, engine, created_at
      FROM sources
      WHERE research_id = ?
      ORDER BY position ASC, id ASC
    `).all(researchId).map((row) => ({
      id: row.id,
      researchId: row.research_id,
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      engine: row.engine,
      createdAt: row.created_at,
    }));
  }
}
