export class ResearchRepository {
  constructor(db) {
    this.db = db;
  }

  create({ id, query, strategy }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO research_history (id, query, status, strategy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, query, 'queued', strategy, now, now);
    return this.get(id);
  }

  updateStatus(id, status, fields = {}) {
    const current = this.get(id);
    if (!current) return undefined;

    const next = {
      report: fields.report ?? current.report,
      error: fields.error ?? current.error,
      completedAt: fields.completedAt ?? current.completedAt,
    };

    this.db.prepare(`
      UPDATE research_history
      SET status = ?, report = ?, error = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, next.report, next.error, next.completedAt, new Date().toISOString(), id);

    return this.get(id);
  }

  list() {
    return this.db.prepare(`
      SELECT id, query, status, strategy, report, error, created_at, updated_at, completed_at
      FROM research_history
      ORDER BY created_at DESC
    `).all().map(mapResearch);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, query, status, strategy, report, error, created_at, updated_at, completed_at
      FROM research_history
      WHERE id = ?
    `).get(id);
    return row ? mapResearch(row) : undefined;
  }

  delete(id) {
    const result = this.db.prepare('DELETE FROM research_history WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

function mapResearch(row) {
  return {
    id: row.id,
    query: row.query,
    status: row.status,
    strategy: row.strategy,
    report: row.report,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
