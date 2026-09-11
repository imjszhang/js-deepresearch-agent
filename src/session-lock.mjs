import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A dedicated SQLite lock uses OS locks: process death releases it automatically.
// Never unlink this file; removing a live lock's inode could admit another writer.
export function acquireSessionLock(sessionDir) {
  const file = path.join(fs.realpathSync(sessionDir), '.writer.sqlite');
  let lock;
  try {
    lock = new Database(file, { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    lock?.close();
    if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(cause.code)) throw cause;
    const error = new Error('Session is already being written by another process', { cause });
    error.code = 'SESSION_BUSY';
    throw error;
  }
  return () => {
    try { lock.close(); } catch { /* already released; never obscure the result */ }
  };
}
