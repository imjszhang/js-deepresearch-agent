import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERIFICATION_VERSION, VERIFICATION_SCENARIOS, scenarioResults } from './verification-scenarios.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const checks = [{ id: 'test', args: ['test'] }, { id: 'lint', args: ['run', 'lint'] }, { id: 'build', args: ['run', 'build'] },
  { id: 'diffCheck', command: 'git', args: ['diff', '--check'] }];
const invalid = () => { throw Object.assign(new Error('PROGRAM_VERIFICATION_INVALID'), { code: 'PROGRAM_VERIFICATION_INVALID' }); };
const roots = ['scripts', 'src', 'tests', 'web', 'packages/js-deepresearch-engine/src', 'packages/js-deepresearch-engine/tests',
  'packages/js-wiki-engine/src', 'packages/js-wiki-engine/tests'];
const optionalRoots = ['public'];
const individual = ['vite.config.mjs', 'package.json', 'package-lock.json', 'eslint.config.mjs', '.github/workflows/ci.yml',
  'packages/js-deepresearch-engine/package.json', 'packages/js-wiki-engine/package.json'];
export function programImplementationIdentity(cwd = process.cwd()) {
  const files = [];
  const walk = relative => {
    const absolute = path.join(cwd, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) invalid();
    if (stat.isDirectory()) for (const child of fs.readdirSync(absolute).sort()) walk(path.join(relative, child));
    else if (stat.isFile()) files.push({ file: relative, hash: digest(fs.readFileSync(absolute)) });
  };
  for (const entry of [...roots, ...individual]) walk(entry);
  for (const entry of optionalRoots) {
    if (fs.existsSync(path.join(cwd, entry))) walk(entry);
    else files.push({ file: entry, exists: false, hash: null });
  }
  return { hash: digest(files), files };
}
function write(file, value) { const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, file); }
function cleanEnvironment(cwd, outputDir, guarded = true) {
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { CI: '1', NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    JDR_VERIFY_ACTIVE: '1', JDR_VERIFY_ROOT: cwd, JDR_VERIFY_NETWORK_LOG: path.join(outputDir, 'network.jsonl') });
  if (guarded) env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(moduleDir, 'verification-network-guard.cjs'))} --test-reporter=${JSON.stringify(path.join(moduleDir, 'verification-reporter.mjs'))}`;
  return env;
}
function isolationFor(cwd, outputDir) {
  const probe = path.join(moduleDir, 'verification-network-probe.mjs');
  if (process.platform === 'darwin') {
    const profile = `(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(deny file-read* (literal ${JSON.stringify(path.join(cwd, '.env'))}))(deny file-read* (subpath ${JSON.stringify(path.join(cwd, 'data'))}))`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, probe], { cwd, env: cleanEnvironment(cwd, outputDir, false), encoding: 'utf8', timeout: 5000 });
    let evidence; try { evidence = JSON.parse(result.stdout); } catch { /* unavailable */ }
    return { supported: result.status === 0 && evidence?.loopback === true && evidence?.externalDenied === true,
      kind: 'macos_sandbox_exec', evidence: { loopback: evidence?.loopback === true, externalDenied: evidence?.externalDenied === true },
      wrap: (command, args) => ({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] }) };
  }
  if (process.platform === 'linux') {
    // CI enters a fresh network namespace before launching this runner. Do not
    // trust its environment flag: inspect actual interfaces and probe routing.
    const devices = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
    if (devices.length === 1 && devices[0] === 'lo') {
      const result = spawnSync(process.execPath, [probe], { cwd, env: cleanEnvironment(cwd, outputDir, false), encoding: 'utf8', timeout: 5000 });
      let evidence; try { evidence = JSON.parse(result.stdout); } catch { /* unavailable */ }
      return { supported: result.status === 0 && evidence?.loopback && evidence?.externalDenied, kind: 'linux_network_namespace',
        evidence: { loopback: evidence?.loopback === true, externalDenied: evidence?.externalDenied === true, onlyLoopbackInterface: true }, wrap: (command, args) => ({ command, args }) };
    }
  }
  return { supported: false, kind: 'unavailable', evidence: { externalDenied: false } };
}
export function parseVerificationEvents(log) {
  return log.split('\n').filter(line => line.startsWith('JDR_VERIFY_EVENT ')).flatMap(line => {
    try { const event = JSON.parse(line.slice(17)); return event && typeof event.type === 'string' ? [event] : []; } catch { return []; }
  });
}
export function verificationStreamsComplete(events) {
  let count = 0, plans = 0, streams = 0, topLevelCompleted = 0, rootPlan = null;
  for (const event of events) {
    if (event.type === 'verification:stream_end') {
      if (!count || !plans || !rootPlan || rootPlan.count !== topLevelCompleted
        || event.eventCount !== count || event.planCount !== plans) return false;
      streams++; count = 0; plans = 0; topLevelCompleted = 0; rootPlan = null;
    } else {
      if (rootPlan || !['test:pass', 'test:fail', 'test:plan'].includes(event.type)) return false;
      if (event.type === 'test:plan') {
        if (!Number.isInteger(event.count) || event.count < 0) return false;
        plans++;
        if (event.nesting === 0 && !event.file) rootPlan = event;
      } else if (event.nesting === 0) topLevelCompleted++;
      count++;
    }
  }
  return streams > 0 && count === 0;
}
function networkSummary(log) {
  const counts = { expectedBlockedAttempts: 0, unexpectedExternalAttempts: 0, actualExternalDispatches: 0, loopbackConnections: 0, localSocketConnections: 0, listener: 0 };
  for (const line of log.split('\n').filter(Boolean)) { try { const event = JSON.parse(line); if (Object.hasOwn(counts, event.kind)) counts[event.kind]++; else invalid(); } catch { invalid(); } }
  return counts;
}
function execute(command, args, { cwd, env, logFile, timeoutMs = 300000 }) {
  return new Promise(resolve => {
    const fd = fs.openSync(logFile, 'w', 0o600), started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    let settled = false;
    const done = (code, error = false) => { if (settled) return; settled = true; clearTimeout(timer); fs.closeSync(fd);
      resolve({ exitCode: code, timedOut, error, elapsedMs: Date.now() - started }); };
    child.once('error', () => done(null, true)); child.once('close', code => done(code));
  });
}

// This execution core is injectable for runner unit tests. Only the public
// runProgramVerification entry writes a production certificate.
export async function executeVerificationChecks({ cwd, outputDir, isolation, executeCheck = execute }) {
  const results = [];
  for (const check of checks) {
    const logFile = path.join(outputDir, `${check.id}.log`), invocation = isolation.wrap(check.command || 'npm', check.args);
    const result = await executeCheck(invocation.command, invocation.args, { cwd, env: cleanEnvironment(cwd, outputDir), logFile });
    const events = check.id === 'test' ? parseVerificationEvents(fs.readFileSync(logFile, 'utf8')) : [];
    const testComplete = check.id !== 'test' || verificationStreamsComplete(events) && events.some(e => e.type === 'test:pass' || e.type === 'test:fail')
      && !events.some(e => e.skip || e.todo);
    const row = { id: check.id, ...result, status: result.error || result.timedOut || !testComplete ? 'incomplete' : result.exitCode === 0 ? 'passed' : 'failed',
      ...(check.id === 'test' ? { events, scenarios: scenarioResults(events) } : {}) };
    write(path.join(outputDir, `${check.id}.json`), row); results.push(row);
  }
  return results;
}
export async function runProgramVerification({ outputDir, cwd = process.cwd() }) {
  if (!outputDir) throw Object.assign(new Error('PROGRAM_VERIFICATION_RECURSION_OR_OUTPUT'), { code: 'PROGRAM_VERIFICATION_RECURSION_OR_OUTPUT' });
  cwd = fs.realpathSync(cwd); outputDir = path.resolve(outputDir);
  // Resolve existing ancestors before checking containment; output aliases must
  // not overwrite inputs or enter the implementation snapshot.
  const missing = []; let ancestor = outputDir;
  while (!fs.existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  outputDir = path.join(fs.realpathSync(ancestor), ...missing);
  if (fs.existsSync(outputDir) && (!fs.statSync(outputDir).isDirectory() || fs.readdirSync(outputDir).length)) {
    throw Object.assign(new Error('PROGRAM_VERIFICATION_OUTPUT_NOT_EMPTY'), { code: 'PROGRAM_VERIFICATION_OUTPUT_NOT_EMPTY' });
  }
  if (outputDir === cwd || [...roots, ...optionalRoots].some(root => outputDir === path.join(cwd, root) || outputDir.startsWith(path.join(cwd, root) + path.sep))) invalid();
  if (process.env.JDR_VERIFY_ACTIVE) throw Object.assign(new Error('PROGRAM_VERIFICATION_RECURSION_OR_OUTPUT'), { code: 'PROGRAM_VERIFICATION_RECURSION_OR_OUTPUT' });
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, 'program-verification.json');
  if (fs.existsSync(file)) throw Object.assign(new Error('PROGRAM_VERIFICATION_OUTPUT_EXISTS'), { code: 'PROGRAM_VERIFICATION_OUTPUT_EXISTS' });
  fs.writeFileSync(path.join(outputDir, 'network.jsonl'), '');
  const before = programImplementationIdentity(cwd), isolation = isolationFor(cwd, outputDir);
  const record = { schemaVersion: 1, verificationVersion: VERIFICATION_VERSION, origin: 'program_check', scope: 'program_contracts',
    implementationIdentity: before.hash, files: before.files, scenarioManifestHash: digest(VERIFICATION_SCENARIOS),
    environment: { node: process.version, platform: process.platform, arch: process.arch }, startedAt: new Date().toISOString(),
    isolation: { kind: isolation.kind, supported: Boolean(isolation.supported), evidence: isolation.evidence }, checks: [], scenarios: [], status: 'incomplete' };
  if (isolation.supported) record.checks = await executeVerificationChecks({ cwd, outputDir, isolation });
  record.scenarios = record.checks.find(c => c.id === 'test')?.scenarios || scenarioResults([]);
  record.network = networkSummary(fs.readFileSync(path.join(outputDir, 'network.jsonl'), 'utf8'));
  record.identityUnchanged = before.hash === programImplementationIdentity(cwd).hash;
  const complete = record.isolation.supported && record.identityUnchanged && record.checks.length === checks.length
    && record.checks.every(c => c.status !== 'incomplete') && record.scenarios.every(s => s.status !== 'incomplete');
  const failed = record.checks.some(c => c.status === 'failed') || record.scenarios.some(s => s.status === 'failed')
    || record.network.unexpectedExternalAttempts > 0 || record.network.actualExternalDispatches > 0;
  record.status = failed ? 'failed' : complete && record.network.expectedBlockedAttempts > 0 ? 'passed' : 'incomplete';
  record.finishedAt = new Date().toISOString();
  record.artifacts = [...record.checks.flatMap(c => [`${c.id}.log`, `${c.id}.json`]), 'network.jsonl'].map(relative => ({ file: relative, hash: digest(fs.readFileSync(path.join(outputDir, relative))) }));
  write(file, record); return record;
}
export function requireProgramVerification(file, { cwd = process.cwd() } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(file)), directory = path.dirname(path.resolve(file));
    if (record.schemaVersion !== 1 || record.verificationVersion !== VERIFICATION_VERSION || record.origin !== 'program_check' || record.scope !== 'program_contracts'
      || record.environment?.node !== process.version || record.environment?.platform !== process.platform || record.environment?.arch !== process.arch
      || record.isolation?.kind === 'linux_network_namespace' && record.isolation.evidence?.onlyLoopbackInterface !== true
      || record.status !== 'passed' || !record.identityUnchanged || record.implementationIdentity !== programImplementationIdentity(cwd).hash
      || digest(record.files) !== record.implementationIdentity || record.scenarioManifestHash !== digest(VERIFICATION_SCENARIOS)
      || !record.isolation?.supported || !record.isolation.evidence.externalDenied || !record.isolation.evidence.loopback
      || !['macos_sandbox_exec', 'linux_network_namespace'].includes(record.isolation.kind)
      || record.checks?.length !== checks.length || checks.some(c => !record.checks.some(r => r.id === c.id && r.status === 'passed' && r.exitCode === 0 && !r.error && !r.timedOut))) invalid();
    const expectedFiles = [...checks.flatMap(c => [`${c.id}.log`, `${c.id}.json`]), 'network.jsonl'];
    if (record.artifacts?.length !== expectedFiles.length || new Set(record.artifacts.map(a => a.file)).size !== expectedFiles.length) invalid();
    for (const relative of expectedFiles) {
      const entry = record.artifacts.find(a => a.file === relative), absolute = path.join(directory, relative);
      if (!entry || fs.lstatSync(absolute).isSymbolicLink() || digest(fs.readFileSync(absolute)) !== entry.hash) invalid();
    }
    for (const check of record.checks) if (digest(JSON.parse(fs.readFileSync(path.join(directory, `${check.id}.json`)))) !== digest(check)) invalid();
    const events = parseVerificationEvents(fs.readFileSync(path.join(directory, 'test.log'), 'utf8'));
    if (digest(scenarioResults(events)) !== digest(record.scenarios) || record.scenarios.some(s => s.status !== 'passed')
      || !verificationStreamsComplete(events) || events.some(e => e.type === 'test:fail' || e.skip || e.todo)
      || digest(events) !== digest(record.checks.find(c => c.id === 'test').events)) invalid();
    const network = networkSummary(fs.readFileSync(path.join(directory, 'network.jsonl'), 'utf8'));
    if (digest(network) !== digest(record.network) || network.actualExternalDispatches || network.unexpectedExternalAttempts || !network.expectedBlockedAttempts) invalid();
    return record;
  } catch { invalid(); }
}
