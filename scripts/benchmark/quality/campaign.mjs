import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { hash, readJson, writeJson, invariant, validateCase } from './schema.mjs';
import { pinResult } from './load-result.mjs';
import { acquireSessionLock } from '../../../src/session-lock.mjs';
import { selectResearchResumePlan } from 'js-deepresearch-engine';
import { killProcessTree } from '../../../src/search-providers/js-eyes/cli-process.mjs';

const environmentFailures = new Set(['SEARCH_PROVIDER_UNAVAILABLE', 'ENOSPC', 'SQLITE_FULL', 'CLI_SPAWN_FAILED',
  'INVALID_REPORT_BUDGET_CONFIGURATION', 'RESUME_CONFIG_IDENTITY_MISMATCH', 'RESUME_CONFIG_UNRESOLVED', 'RUN_CONFIG_INTEGRITY', 'CAMPAIGN_STATE_WRITE_FAILED']);
function safeFailure(error) { return environmentFailures.has(error?.code) ? error.code : 'CAMPAIGN_EXECUTION_FAILED'; }
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return { alive: false, identity: null };
  try { process.kill(pid, 0); } catch (error) { return { alive: error.code === 'EPERM', identity: null }; }
  try {
    if (process.platform === 'win32') return { alive: true, identity: null };
    const identity = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim();
    return { alive: true, identity: identity || null };
  } catch { return { alive: true, identity: null }; }
}

export function reconcileRun(run, inspectProcess = processIdentity) {
  if (run.pid) {
    const observed = inspectProcess(run.pid);
    if (observed.alive && (!observed.identity || !run.processIdentity)) return 'unknown';
    if (observed.alive && observed.identity === run.processIdentity) return 'running';
  }
  const session = run.sessionDir || run.resumeSession || findSession(run.directory);
  if (session) {
    try {
      if (selectResearchResumePlan({ sessionDir: session }).mode === 'commit-result') {
        run.pin = pinResult(session); run.sessionDir = session;
        delete run.pid; delete run.processIdentity;
        return 'research_complete';
      }
    } catch { /* retain failed/unknown artifact for explicit validation */ }
  }
  delete run.pid; delete run.processIdentity;
  const attempt = run.attempts?.at(-1);
  if (attempt && !attempt.finishedAt) {
    const failureFile = session && path.join(session, 'failure.json');
    const endedAt = failureFile && fs.existsSync(failureFile) ? readJson(failureFile).completedAt : null;
    attempt.finishedAt = endedAt || new Date().toISOString();
    attempt.activeMs = Math.max(0, Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt));
    attempt.timingBasis = endedAt ? 'recorded_failure' : 'conservative_upper_bound';
  }
  return 'interrupted';
}

export function publicSettings(value, key = '') {
  if (/api.?key|password|secret|authorization|cookie|credential|token(?!s)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(x => publicSettings(x));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicSettings(v, k)]));
  if (typeof value === 'string' && /url|proxy/i.test(key) && value) {
    try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; } catch { return '[invalid-url]'; }
  }
  return value;
}
export function treeHash(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'data', 'work_dir', 'dist'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push([path.relative(root, file), hash(fs.readFileSync(file))]);
    }
  }
  walk(root); return hash(files);
}
export function fingerprint(settings, skillDir, cwd = process.cwd()) {
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    runtimeHash: hash(['src', 'packages/js-deepresearch-engine/src'].map(p => treeHash(path.join(cwd, p)))),
    lockfileHash: hash(fs.readFileSync(path.join(cwd, 'package-lock.json'))),
    settingsHash: hash(publicSettings(settings)), settings: publicSettings(settings),
    skillHash: treeHash(skillDir), nodeVersion: process.version };
}
export function runArguments(run, protocol, cliPath) {
  const base = ['exec', '--package=.', '--', 'jdr', 'research'];
  if (run.resumeSession) return [...base, '--resume', run.resumeSession, '--no-save', '--json'];
  return [...base, run.case.query, '--strategy', 'exploratory', '--search', 'js-eyes', '--search-skills', protocol.skill,
    '--search-cli', cliPath, '--search-server-url', protocol.serverUrl,
    '--search-language', protocol.language, '--search-max-pages', String(protocol.searchMaxPages),
    '--concurrency', '1', '--exploratory-min-llm-tokens', String(protocol.minTokens),
    '--exploratory-max-llm-tokens', String(protocol.maxTokens), '--max-total-llm-tokens', String(protocol.totalTokens),
    '--report-max-output-tokens', String(protocol.reportMaxOutputTokens),
    '--work-dir', run.directory, '--no-save', '--json'];
}
export function createCampaign({ suite, directory, identity, cliPath, skillDir }) {
  invariant(!fs.existsSync(path.join(directory, 'campaign.json')), 'Campaign already exists');
  const protocol = suite.protocol;
  invariant(protocol.minTokens === 600000 && protocol.maxTokens === 1000000 && protocol.totalTokens >= protocol.maxTokens, 'Invalid budget contract');
  invariant(Number.isInteger(protocol.reportMaxOutputTokens) && protocol.reportMaxOutputTokens > 0,
    'A total research fuse requires a bounded report output reservation');
  const runs = [];
  for (let repeat = 1; repeat <= suite.repeats; repeat++) {
    const ordered = suite.cases.slice().sort((a, b) => hash(`${suite.seed}:${repeat}:${a.id}`).localeCompare(hash(`${suite.seed}:${repeat}:${b.id}`)));
    for (const c of ordered) {
      const id = `${c.id}-${repeat}`;
      runs.push({ id, case: c, repeat, status: 'queued', directory: path.resolve(directory, id), attempts: [] });
    }
  }
  const campaign = { schemaVersion: 1, id: path.basename(directory), createdAt: new Date().toISOString(), mode: 'live_google',
    suiteHash: suite.suiteHash, protocolVersion: suite.protocolVersion, protocol, seed: suite.seed, identity, cliPath, skillDir, runs };
  writeJson(path.join(directory, 'campaign.json'), campaign);
  return campaign;
}
export async function spawnRun({ args, cwd, directory, timeoutMs, onStarted = () => {}, signal, spawnProcess = spawn,
  killProcess = (child, sig) => { if (process.platform === 'win32') { child.kill(sig); killProcessTree(child.pid); } else process.kill(-child.pid, sig); } }) {
  fs.mkdirSync(directory, { recursive: true });
  let out, err;
  try {
    out = fs.openSync(path.join(directory, 'stdout.json'), 'wx', 0o600);
    err = fs.openSync(path.join(directory, 'stderr.log'), 'wx', 0o600);
  } catch (error) { if (out != null) fs.closeSync(out); throw error; }
  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess('npm', args, { cwd, stdio: ['ignore', out, err], detached: process.platform !== 'win32' }); }
    catch (e) { fs.closeSync(out); fs.closeSync(err); reject(Object.assign(new Error('CLI_SPAWN_FAILED', { cause: e }), { code: 'CLI_SPAWN_FAILED' })); return; }
    fs.closeSync(out); fs.closeSync(err);
    let timer, forceTimer, timedOut = false, aborted = false, failureCode = null, stopping = false;
    const kill = sig => { try { killProcess(child, sig); } catch { /* already exited */ } };
    const stop = () => { if (stopping) return; stopping = true; forceTimer = setTimeout(() => kill('SIGKILL'), 30000); kill('SIGINT'); };
    const onAbort = () => { aborted = true; stop(); };
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', () => { cleanup(); reject(Object.assign(new Error('CLI_SPAWN_FAILED'), { code: 'CLI_SPAWN_FAILED' })); });
    child.once('close', (code, killedBy) => { cleanup(); resolve({ code, killedBy, timedOut, aborted, failureCode }); });
    if (signal?.aborted) onAbort();
    try { onStarted(child.pid); }
    catch (error) { failureCode = environmentFailures.has(error?.code) ? error.code : 'CAMPAIGN_STATE_WRITE_FAILED'; stop(); }
  });
}
export function findSession(directory) {
  const root = path.join(directory, 'exploratory');
  if (!fs.existsSync(root)) return null;
  const sessions = fs.readdirSync(root).filter(f => fs.existsSync(path.join(root, f, 'run.json')));
  invariant(sessions.length <= 1, 'Ambiguous research session');
  return sessions.length ? path.join(root, sessions[0]) : null;
}
export function inspectGoogleTrust(cliPath, skill) {
  const output = execFileSync(cliPath, ['skills', 'inspect', skill, '--json'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  const inspected = JSON.parse(output);
  invariant(inspected.id === skill && inspected.trust?.approved === true, 'GOOGLE_SKILL_NOT_TRUSTED');
  return { skill, version: inspected.version, sourceDigest: inspected.trust.sourceDigest,
    descriptorDigest: inspected.trust.descriptorDigest, inspectedAt: new Date().toISOString() };
}
export async function runCampaign({ file, currentIdentity, signal, execute = spawnRun, onProgress = () => {}, resumeRun = null, beforeRun = () => {} }) {
  const release = acquireSessionLock(path.dirname(file));
  try {
    const campaign = readJson(file);
    invariant(hash(currentIdentity) === hash(campaign.identity), 'Frozen runtime/configuration changed');
    const legacyLock = `${file}.lock`;
    if (fs.existsSync(legacyLock)) {
      const owner = readJson(legacyLock);
      invariant(!processIdentity(owner.pid).alive, 'Legacy campaign writer may still be active');
      fs.unlinkSync(legacyLock);
    }
    for (const run of campaign.runs.filter(r => ['running', 'unknown'].includes(r.status))) {
      run.status = reconcileRun(run);
      if (run.status === 'interrupted') { campaign.status = 'environment_paused'; campaign.pauseReason = 'INTERRUPTED_ATTEMPT'; }
    }
    writeJson(file, campaign);
    if (resumeRun) {
      const r = campaign.runs.find(r => r.id === resumeRun);
      invariant(r && ['research_failed', 'cancelled', 'interrupted'].includes(r.status) && !r.pin, 'Run cannot be resumed');
      invariant((r.recoveryAttempts || 0) < 1, 'Run recovery limit reached');
      r.resumeSession = findSession(r.directory);
      invariant(r.resumeSession || campaign.pauseReason === 'PREFLIGHT_FAILED' && !r.sessionDir, 'No recoverable session');
      invariant(!['running', 'unknown'].includes(reconcileRun(r)), 'Run process may still be alive');
      if (r.pin) { r.status = 'research_complete'; writeJson(file, campaign); return campaign; }
      r.recoveryAttempts = (r.recoveryAttempts || 0) + 1;
      r.status = 'queued';
      campaign.status = 'running'; delete campaign.pauseReason;
    }
    if (campaign.status === 'environment_paused' && !resumeRun) return campaign;
    if (campaign.runs.some(r => ['running', 'unknown'].includes(r.status))) return campaign;
    for (const run of campaign.runs) {
      if (run.status !== 'queued') continue;
      signal?.throwIfAborted(); validateCase(run.case);
      let expected;
      try { expected = await beforeRun(run); }
      catch (error) {
        campaign.status = 'environment_paused'; campaign.pauseReason = safeFailure(error);
        writeJson(file, campaign); throw error;
      }
      if (expected?.configHash) run.expectedConfigHash = expected.configHash;
      const usedMs = run.attempts.reduce((n, a) => n + (a.activeMs ?? (a.finishedAt ? Math.max(0, Date.parse(a.finishedAt) - Date.parse(a.startedAt)) : 0)), 0);
      const remainingMs = campaign.protocol.wallClockMs - usedMs;
      invariant(remainingMs > 0, 'Run wall clock budget exhausted');
      const attempt = { attemptId: `${run.id}-${run.attempts.length + 1}`, startedAt: new Date().toISOString(), directory: path.join(run.directory, `attempt-${run.attempts.length + 1}`) };
      run.attempts.push(attempt); run.status = 'running'; writeJson(file, campaign);
      onProgress({ id: run.id, status: 'running' });
      const started = Date.now(); let outcome;
      try {
        outcome = await execute({ args: runArguments(run, campaign.protocol, campaign.cliPath), cwd: process.cwd(),
          directory: attempt.directory, timeoutMs: remainingMs, signal,
          onStarted: pid => { run.pid = pid; run.processIdentity = processIdentity(pid).identity; writeJson(file, campaign); } });
      } catch (error) { outcome = { code: 1, failureCode: safeFailure(error) }; }
      Object.assign(attempt, outcome, { finishedAt: new Date().toISOString(), activeMs: Date.now() - started }); delete run.pid; delete run.processIdentity;
      const session = run.resumeSession || findSession(run.directory);
      run.status = outcome.aborted || outcome.timedOut ? 'cancelled' : 'research_failed';
      let failureCode = outcome.failureCode;
      if (session) {
        run.sessionDir = session;
        const failure = path.join(session, 'failure.json');
        if (fs.existsSync(failure)) failureCode ||= readJson(failure)?.error?.code;
        if (outcome.code === 0 && !outcome.failureCode) {
          try {
            const recorded = readJson(path.join(session, 'run.json'));
            invariant(!run.expectedConfigHash || recorded.executionConfig?.configHash === run.expectedConfigHash, 'Actual execution configuration differs');
            run.pin = pinResult(session); run.status = 'research_complete';
          }
          catch { run.status = 'artifact_invalid'; }
        }
      }
      if (!session || environmentFailures.has(failureCode) || run.status === 'artifact_invalid') {
        campaign.status = 'environment_paused'; campaign.pauseReason = failureCode || (!session ? 'PREFLIGHT_FAILED' : 'ARTIFACT_INVALID');
      }
      attempt.failureCode = failureCode || null;
      writeJson(file, campaign); onProgress({ id: run.id, status: run.status });
      // No session means preflight/environment failed; stop the batch, not eight identical failures.
      if (campaign.status === 'environment_paused' || outcome.aborted || outcome.timedOut) break;
    }
    if (campaign.runs.every(r => !['queued', 'running', 'unknown', 'interrupted'].includes(r.status)) && campaign.status !== 'environment_paused') campaign.status = 'finished';
    writeJson(file, campaign);
    return campaign;
  } finally { release(); }
}
