import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { sourceKey } from './source-key.mjs';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'js-deepresearch.sqlite');

let db;

export function getDb() {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  return db;
}

export function migrateDb(database) {
  migrate(database);
  return database;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT NOT NULL,
      report TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS research_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      progress INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (research_id) REFERENCES research_history(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_id TEXT NOT NULL,
      title TEXT,
      url TEXT,
      snippet TEXT,
      engine TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (research_id) REFERENCES research_history(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(database, 'research_history', 'quality_json', 'TEXT');
  ensureColumn(database, 'research_history', 'session_dir', 'TEXT');
  ensureColumn(database, 'research_history', 'result_revision', 'TEXT');
  ensureColumn(database, 'research_history', 'result_manifest_path', 'TEXT');
  ensureColumn(database, 'research_history', 'delivery_json', 'TEXT');
  database.transaction(() => {
    ensureColumn(database, 'sources', 'source_key', 'TEXT');
    ensureColumn(database, 'sources', 'position', 'INTEGER NOT NULL DEFAULT 0');
    if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sources_research_key'").get()) return;
    const seen = new Map();
    const positions = new Map();
    for (const row of database.prepare('SELECT * FROM sources ORDER BY id').all()) {
      const key = sourceKey(row);
      const group = JSON.stringify([row.research_id, key]);
      const existingId = seen.get(group);
      if (existingId) {
        database.prepare('UPDATE sources SET title=?, url=?, snippet=?, engine=? WHERE id=?')
          .run(row.title, row.url, row.snippet, row.engine, existingId);
        database.prepare('DELETE FROM sources WHERE id=?').run(row.id);
      } else {
        const position = positions.get(row.research_id) || 0;
        database.prepare('UPDATE sources SET source_key=?, position=? WHERE id=?').run(key, position, row.id);
        seen.set(group, row.id);
        positions.set(row.research_id, position + 1);
      }
    }
    database.exec('CREATE UNIQUE INDEX sources_research_key ON sources(research_id, source_key)');
  })();
}

function ensureColumn(database, table, column, type) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
