/* global process, URL */
// OS isolation is authoritative. Hooks add safe accounting and constrain localhost
// to listeners created by this test run; they are not an adversarial JS sandbox.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const dns = require('node:dns'), tls = require('node:tls'), cp = require('node:child_process'), crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const logFile = process.env.JDR_VERIFY_NETWORK_LOG;
const append = fs.appendFileSync.bind(fs), read = fs.readFileSync.bind(fs);
const root = process.env.JDR_VERIFY_ROOT || process.cwd();
function testFileFrom(value) {
  if (typeof value !== 'string') return undefined;
  const relative = path.relative(root, path.resolve(value)).split(path.sep).join('/');
  return /^(?:tests|packages\/(?:js-deepresearch-engine|js-wiki-engine)\/tests)\/[a-zA-Z0-9_./-]+\.test\.mjs$/.test(relative) ? relative : undefined;
}
const testFile = process.argv.map(testFileFrom).find(Boolean) || testFileFrom(process.env.JDR_VERIFY_TEST_FILE && path.join(root, process.env.JDR_VERIFY_TEST_FILE));
if (testFile) process.env.JDR_VERIFY_TEST_FILE = testFile;
let expectedDepth = 0;
function record(kind, extra = {}) { if (logFile) append(logFile, JSON.stringify({ kind, pid: process.pid, ...(testFile ? { testFile } : {}), ...extra }) + '\n'); }
function denied(operation) { record(expectedDepth ? 'expectedBlockedAttempts' : 'unexpectedExternalAttempts', { operation }); throw Object.assign(new Error('PROGRAM_EXTERNAL_CALL_BLOCKED'), { code: 'PROGRAM_EXTERNAL_CALL_BLOCKED' }); }
function loopback(host) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host)); }
function socketHash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function registered(port, socket) {
  if (!logFile) return false;
  try { return read(logFile, 'utf8').split('\n').filter(Boolean).some(line => { try { const r = JSON.parse(line); return r.kind === 'listener' && (socket ? r.socketHash === socketHash(socket) : r.port === Number(port)); } catch { return false; } }); } catch { return false; }
}
function connection(args) {
  if (Array.isArray(args[0])) args = args[0];
  const first = args[0];
  if (typeof first === 'string' && !/^\d+$/.test(first) || first && typeof first === 'object' && first.path) {
    if (!registered(null, typeof first === 'string' ? first : first.path)) denied('unowned_local_socket');
    record('localSocketConnections'); return;
  }
  const options = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options.socket) return;
  if (!loopback(options.host || options.hostname || 'localhost')) denied('external_socket');
  if (!registered(options.port)) denied('unowned_loopback');
  record('loopbackConnections');
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { connection(args); return originalConnect.apply(this, args); };
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if (first && typeof first === 'object' && !first.path) {
    if (first.host && !['0.0.0.0', '::'].includes(first.host) && !loopback(first.host)) denied('external_listener');
    args[0] = { ...first, host: loopback(first.host) ? first.host : '127.0.0.1' };
  } else if (typeof first === 'number') {
    if (typeof args[1] === 'string') { if (!loopback(args[1]) && !['0.0.0.0', '::'].includes(args[1])) denied('external_listener'); if (!loopback(args[1])) args[1] = '127.0.0.1'; }
    else args.splice(1, 0, '127.0.0.1');
  }
  this.once('listening', () => { const address = this.address(); if (address && typeof address === 'object') record('listener', { port: address.port }); else if (typeof address === 'string') record('listener', { socketHash: socketHash(address) }); });
  return originalListen.apply(this, args);
};
const originalTls = tls.connect;
tls.connect = function (...args) { connection(args); return originalTls.apply(this, args); };
const originalLookup = dns.lookup;
dns.lookup = function (host, ...args) { if (!loopback(host)) denied('dns_lookup'); return originalLookup.call(this, host, ...args); };
for (const key of Object.keys(dns)) if (key.startsWith('resolve') || key === 'reverse') dns[key] = () => denied('dns_resolve');
dns.promises.lookup = async function (host, options) { if (!loopback(host)) denied('dns_lookup'); return new Promise((resolve, reject) => originalLookup(host, options || {}, (error, address, family) => error ? reject(error) : resolve(options?.all ? address : { address, family }))); };
for (const key of Object.keys(dns.promises)) if (key.startsWith('resolve') || key === 'reverse') dns.promises[key] = async () => denied('dns_resolve');
for (const Constructor of [dns.Resolver, dns.promises.Resolver]) for (const key of Object.getOwnPropertyNames(Constructor.prototype)) {
  if (key.startsWith('resolve') || key === 'reverse') Constructor.prototype[key] = () => denied('dns_resolve');
}
const dgram = require('node:dgram');
dgram.Socket.prototype.send = () => denied('datagram_send');
function urlCheck(value) { const u = value instanceof URL ? value : new URL(typeof value === 'string' ? value : value.url); connection([{ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80) }]); }
const originalFetch = globalThis.fetch;
if (originalFetch) globalThis.fetch = function (url, options) { try { urlCheck(url); return originalFetch(url, options); } catch (error) { return Promise.reject(error); } };
for (const protocol of ['node:http', 'node:https']) {
  const mod = require(protocol);
  for (const method of ['request', 'get']) { const original = mod[method]; mod[method] = function (...args) {
    if (typeof args[0] === 'string' || args[0] instanceof URL) urlCheck(args[0]);
    else if (args[0]?.socketPath) connection([{ path: args[0].socketPath }]);
    else connection([{ host: args[0]?.hostname || args[0]?.host || 'localhost', port: args[0]?.port || (protocol === 'node:https' ? 443 : 80) }]);
    return original.apply(this, args);
  }; }
}
const http2 = require('node:http2'), originalHttp2 = http2.connect;
http2.connect = function (authority, ...args) { urlCheck(authority); return originalHttp2.call(this, authority, ...args); };
const testScript = 'node --test --test-force-exit --test-timeout=15000 tests/*.test.mjs';
const shellScripts = new Set([testScript, 'npm run test -w js-deepresearch-engine && npm run test -w js-wiki-engine && ' + testScript, 'eslint .', 'vite build']);
function shellWords(script) {
  const words = [], token = /(?:'([^']*)'|"([^"$`\\]*)"|([a-zA-Z0-9_./:=*-]+))/y;
  let cursor = 0;
  while (cursor < script.length) {
    while (script[cursor] === ' ') cursor++;
    token.lastIndex = cursor; const match = token.exec(script);
    if (!match || token.lastIndex < script.length && script[token.lastIndex] !== ' ') return [];
    words.push(match[1] ?? match[2] ?? match[3]); cursor = token.lastIndex;
  }
  return words;
}
function allowedCommand(file, argv, options) {
  if (options?.shell) return false;
  const name = path.basename(file), serialized = JSON.stringify(argv);
  if (['node', 'nodejs'].includes(name)) return true; // Every Node child inherits this preload.
  if (name === 'esbuild') return argv.length === 2 && /^--service=[0-9.]+$/.test(argv[0]) && argv[1] === '--ping';
  if (name === 'git') return ['["rev-parse","HEAD"]', '["diff","--check"]'].includes(serialized);
  if (name === 'ps') return argv.length === 6 && argv[0] === '-p' && /^\d+$/.test(argv[1]) && JSON.stringify(argv.slice(2)) === '["-o","lstart=","-o","comm="]';
  if (name === 'npm') {
    return ['["test"]','["run","lint"]','["run","build"]','["run","test","-w","js-deepresearch-engine"]','["run","test","-w","js-wiki-engine"]'].includes(serialized)
      || argv.length === 10 && argv[0] === 'exec' && argv[1].startsWith('--package=') && argv[2] === '--'
        && argv[3] === 'jdr' && argv[4] === 'research' && argv[5] === '--resume' && argv[7] === '--json' && argv[8] === '--output';
  }
  if (name === 'sh' || name === 'bash') {
    if (argv.length !== 2 || argv[0] !== '-c') return false;
    if (shellScripts.has(argv[1])) return true;
    const words = shellWords(argv[1]);
    return words.length === 7 && words[0] === 'jdr' && words[1] === 'research' && words[2] === '--resume'
      && path.isAbsolute(words[3]) && words[4] === '--json' && words[5] === '--output' && path.isAbsolute(words[6]);
  }
  return false;
}
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[key]; cp[key] = function (file, ...args) {
    const index = Array.isArray(args[0]) ? 1 : 0, old = args[index];
    if (!allowedCommand(file, index ? args[0] : [], old)) {
      const command = path.basename(file), category = ['sh', 'bash'].includes(command) ? 'shell' : ['git', 'npm', 'node', 'js-eyes', 'curl'].includes(command) ? command : 'other';
      denied('child_process_' + category);
    }
    if (old && typeof old === 'object') args[index] = { ...old, env: { ...process.env, ...old.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS, JDR_VERIFY_NETWORK_LOG: logFile, JDR_VERIFY_TEST_FILE: testFile, JDR_VERIFY_ACTIVE: '1' } };
    return original.call(this, file, ...args);
  };
}
cp.exec = () => denied('child_process_exec'); cp.execSync = () => denied('child_process_exec');
// Existing tests may load bootstrap-env; the user's real environment file is
// hidden, while temp .env fixtures remain readable.
const privateEnv = path.resolve(process.env.JDR_VERIFY_ROOT || process.cwd(), '.env');
const originalExists = fs.existsSync;
fs.existsSync = function (file) { return path.resolve(String(file)) === privateEnv ? false : originalExists(file); };
fs.readFileSync = function (file, ...args) { if (typeof file !== 'number' && path.resolve(String(file)) === privateEnv) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return read(file, ...args); };
syncBuiltinESMExports();
module.exports = { withExpectedBlockedAttempt: async fn => { expectedDepth++; try { return await fn(); } finally { expectedDepth--; } }, record };
