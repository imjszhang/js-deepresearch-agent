import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

export const sandboxError = code => Object.assign(new Error(code), { code });
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
const defaultDir = () => path.resolve('work_dir/model-sandbox/.resources');
function paths(resourceDir, resourceId) {
  if (typeof resourceId !== 'string' || !resourceId.length) throw sandboxError('SANDBOX_RESOURCE_INVALID');
  const root = path.resolve(resourceDir || defaultDir()); fs.mkdirSync(root, { recursive: true });
  const key = hash(resourceId);
  return { lockFile: path.join(root, key + '.sqlite'), stateFile: path.join(root, key + '.json') };
}
function readState(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, pending: [] };
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.schemaVersion !== 1 || !Array.isArray(state.pending)) throw Error();
    return state;
  } catch { throw sandboxError('SANDBOX_RESOURCE_INTEGRITY'); }
}
function lock(file) {
  const db = new Database(file, { timeout: 0 });
  try { db.exec('BEGIN EXCLUSIVE'); return db; } catch (error) { db.close(); throw error; }
}
export async function acquireSandboxResource({ resourceDir, resourceId, signal, queueMs = 300000 }) {
  const { lockFile, stateFile } = paths(resourceDir, resourceId);
  const start = performance.now(); let db;
  while (!db) {
    if (signal?.aborted) throw sandboxError('SANDBOX_CANCELLED');
    try { db = lock(lockFile); } catch (error) {
      if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) throw sandboxError('SANDBOX_RESOURCE_LOCK');
      if (performance.now() - start >= queueMs) throw sandboxError('SANDBOX_QUEUE_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, Math.min(50, queueMs)));
    }
  }
  let state;
  try { state = readState(stateFile); if (state.pending.length) throw sandboxError('SANDBOX_EXECUTION_UNRESOLVED'); }
  catch (error) { db.close(); throw error; }
  return {
    queueMs: performance.now() - start,
    start(callId, runId) { state.pending.push({ callId, runId, dispatchedAt: new Date().toISOString(), status: 'dispatched' }); atomicJson(stateFile, state); },
    finish(callId, runId, resolved) {
      if (resolved) state.pending = state.pending.filter(item => item.callId !== callId || item.runId !== runId);
      else for (const item of state.pending) if (item.callId === callId && item.runId === runId) item.status = 'outcome_unknown';
      atomicJson(stateFile, state);
    },
    pendingCount() { return state.pending.length; },
    close() { db.close(); },
  };
}
export function resolveUnknownResource({ resourceDir, resourceId, confirmation }) {
  if (confirmation !== 'server-idle-confirmed') throw sandboxError('SANDBOX_CONFIRMATION_REQUIRED');
  const { lockFile, stateFile } = paths(resourceDir, resourceId); let db;
  try { db = lock(lockFile); } catch { throw sandboxError('SANDBOX_RESOURCE_BUSY'); }
  try {
    const state = readState(stateFile), resolvedCount = state.pending.length;
    atomicJson(stateFile, { schemaVersion: 1, pending: [], lastResolution: { method: 'user_confirmation', at: new Date().toISOString(), resolvedCount } });
    return { status: 'resolved', resolvedCount, method: 'user_confirmation' };
  } finally { db.close(); }
}
