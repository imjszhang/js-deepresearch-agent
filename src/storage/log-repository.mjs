export class LogRepository {
  constructor(db) {
    this.db = db;
  }

  add(researchId, { level = 'info', message, progress = null }) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO research_logs (research_id, level, message, progress, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(researchId, level, message, progress, createdAt);

    return {
      id: result.lastInsertRowid,
      researchId,
      level,
      message,
      progress,
      createdAt,
    };
  }

  list(researchId) {
    return this.db.prepare(`
      SELECT id, research_id, level, message, progress, created_at
      FROM research_logs
      WHERE research_id = ?
      ORDER BY id ASC
    `).all(researchId).map((row) => ({
      id: row.id,
      researchId: row.research_id,
      level: row.level,
      message: row.message,
      progress: row.progress,
      createdAt: row.created_at,
    }));
  }
}
