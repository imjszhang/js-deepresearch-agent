import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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
}
