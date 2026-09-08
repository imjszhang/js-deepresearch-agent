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
      report: Object.hasOwn(fields, 'report') ? fields.report : current.report,
      error: Object.hasOwn(fields, 'error') ? fields.error : current.error,
      completedAt: Object.hasOwn(fields, 'completedAt') ? fields.completedAt : current.completedAt,
      quality: Object.hasOwn(fields, 'quality') ? fields.quality : current.quality,
      sessionDir: Object.hasOwn(fields, 'sessionDir') ? fields.sessionDir : current.sessionDir,
    };

    this.db.prepare(`
      UPDATE research_history
      SET status = ?, report = ?, error = ?, completed_at = ?, quality_json = ?, session_dir = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      next.report,
      next.error,
      next.completedAt,
      next.quality ? JSON.stringify(next.quality) : null,
      next.sessionDir,
      new Date().toISOString(),
      id,
    );

    return this.get(id);
  }

  list() {
    return this.db.prepare(`
      SELECT *
      FROM research_history
      ORDER BY created_at DESC
    `).all().map(mapResearch);
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT *
      FROM research_history
      WHERE id = ?
    `).get(id);
    return row ? mapResearch(row) : undefined;
  }

  delete(id) {
    const result = this.db.prepare('DELETE FROM research_history WHERE id = ?').run(id);
    return result.changes > 0;
  }

  saveDelivery(id, delivery) {
    this.db.prepare('UPDATE research_history SET delivery_json=? WHERE id=?').run(JSON.stringify(delivery), id);
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
    quality: parseJson(row.quality_json),
    sessionDir: row.session_dir || null,
    resultRevision: row.result_revision || null,
    resultManifestPath: row.result_manifest_path || null,
    delivery: parseJson(row.delivery_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
