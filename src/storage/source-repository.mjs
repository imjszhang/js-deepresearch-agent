export class SourceRepository {
  constructor(db) {
    this.db = db;
  }

  addMany(researchId, sources) {
    const insert = this.db.prepare(`
      INSERT INTO sources (research_id, title, url, snippet, engine, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const transaction = this.db.transaction((items) => {
      for (const source of items) {
        insert.run(
          researchId,
          source.title || '',
          source.url || '',
          source.snippet || '',
          source.engine || '',
          now,
        );
      }
    });
    transaction(dedupeSources(sources));
  }

  list(researchId) {
    return this.db.prepare(`
      SELECT id, research_id, title, url, snippet, engine, created_at
      FROM sources
      WHERE research_id = ?
      ORDER BY id ASC
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

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = source.url || `${source.title}:${source.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
