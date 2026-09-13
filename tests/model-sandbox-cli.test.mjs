import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSandboxPlan } from '../src/model-sandbox/plan.mjs';
import { runModelSandboxCli } from '../src/model-sandbox/cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src/cli.mjs');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-sandbox-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function invoke(args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS, JDR_VERIFY_ACTIVE: '1',
        ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
function noResearchStorage(dir) {
  for (const name of ['data', 'wiki']) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} must not be initialized`);
}

test('[V25] sandbox help and plan avoid research storage and exclude credentials', async t => {
  const dir = temporary(t);
  const mainHelp = await invoke(['help'], dir);
  assert.equal(mainHelp.code, 0, mainHelp.stderr);
  assert.match(mainHelp.stdout, /research "query"/);
  assert.match(mainHelp.stdout, /model-sandbox help/);
  const help = await invoke(['model-sandbox', 'help'], dir);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--live/);
  const planFile = path.join(dir, 'plan.json');
  const planned = await invoke(['model-sandbox', 'plan', '--suite', 'baseline', '--repeats', '1', '--model', 'fixture-model',
    '--base-url', 'http://127.0.0.1:12345/v1', '--output', planFile, '--json'], dir,
  { OPENAI_API_KEY: 'credential-canary-do-not-persist' });
  assert.equal(planned.code, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).planFile, planFile);
  const bytes = fs.readFileSync(planFile, 'utf8'), plan = JSON.parse(bytes);
  assert.equal(plan.cases.length, 3); assert.equal(plan.cases[0].warmup, true);
  assert.equal(bytes.includes('credential-canary'), false);
  assert.equal((planned.stdout + planned.stderr).includes('credential-canary'), false);
  noResearchStorage(dir);
});

test('[V25] sandbox rejects missing live and unknown flags before dispatch', async t => {
  const dir = temporary(t);
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const plan = createSandboxPlan({ provider: 'openai-compatible', model: 'fixture-model', baseUrl, repetitions: 1 });
  const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  for (const args of [
    ['run', '--plan-file', file],
    ['run', '--plan-file', file, '--live', '--unrecognized'],
    ['replay', dir, '--call', 'llm-1', '--mode', 'stream'],
  ]) {
    const result = await invoke(['model-sandbox', ...args], dir);
    assert.equal(result.code, 1); assert.match(result.stderr, /SANDBOX_(LIVE_REQUIRED|ARGUMENT_INVALID)/);
    assert.equal(result.stdout, '');
  }
  assert.equal(requests, 0); noResearchStorage(dir);
});

test('[V25] sandbox frozen identity is checked before transport and errors stay safe', async t => {
  const dir = temporary(t);
  const plan = createSandboxPlan({ provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:12345/v1' });
  const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
  for (const flags of [['--model', 'different-model'], ['--base-url', 'http://127.0.0.1:12346/v1'], ['--provider', 'ollama']]) {
    const result = await invoke(['model-sandbox', 'run', '--plan-file', file, '--live', ...flags], dir);
    assert.equal(result.code, 1); assert.match(result.stderr, /SANDBOX_IDENTITY_MISMATCH/); assert.equal(result.stdout, '');
  }
  const output = [], errors = [];
  const code = await runModelSandboxCli(['run', '--plan-file', path.join(dir, 'private-path-canary'), '--live'],
    { env: {}, stdout: value => output.push(value), stderr: value => errors.push(value) });
  assert.equal(code, 1); assert.deepEqual(output, []); assert.deepEqual(errors, ['SANDBOX_PLAN_INVALID']);
  noResearchStorage(dir);
});

test('[V25] sandbox live loopback CLI emits one result and inspect compare remain isolated', async t => {
  const dir = temporary(t), received = [];
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes;
    const body = JSON.parse(text); received.push({ body, authorization: request.headers.authorization });
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'READY' }, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ index: 0, message: { content: 'READY' }, finish_reason: 'stop' }], usage }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const plan = createSandboxPlan({ provider: 'openai-compatible', model: 'fixture-model', baseUrl, repetitions: 1 });
  const planFile = path.join(dir, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan));
  const runDir = path.join(dir, 'run'), resourceDir = path.join(dir, 'resources');
  const result = await invoke(['model-sandbox', 'run', '--plan-file', planFile, '--live', '--output-dir', runDir,
    '--resource-dir', resourceDir, '--json'], dir, { OPENAI_API_KEY: 'credential-canary-do-not-persist',
    LLM_MODEL: 'environment-must-not-override-plan', OPENAI_BASE_URL: 'http://127.0.0.1:1/ignored' });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.summary.status, 'completed'); assert.equal(value.summary.dispatched, 3);
  assert.equal(value.summary.origin, 'fixture');
  assert.equal(received.length, 3); assert.ok(received.every(item => item.body.model === 'fixture-model'));
  assert.ok(received.every(item => item.authorization === 'Bearer credential-canary-do-not-persist'));
  assert.equal((result.stdout + result.stderr).includes('credential-canary'), false);
  const inspected = await invoke(['model-sandbox', 'inspect', runDir, '--json'], dir);
  assert.equal(inspected.code, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).complete, true);
  const compared = await invoke(['model-sandbox', 'compare', runDir, runDir, '--json'], dir);
  assert.equal(compared.code, 0, compared.stderr); assert.equal(JSON.parse(compared.stdout).comparable, true);
  assert.equal(received.length, 3); noResearchStorage(dir);
});

test('[V25] sandbox unknown resource resolution requires explicit server idle confirmation', async t => {
  const dir = temporary(t), resourceDir = path.join(dir, 'resources');
  const rejected = await invoke(['model-sandbox', 'resolve-unknown', '--resource-id', 'fixture-device', '--resource-dir', resourceDir], dir);
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /SANDBOX_CONFIRMATION_REQUIRED/);
  assert.equal(fs.existsSync(resourceDir), false);
  const accepted = await invoke(['model-sandbox', 'resolve-unknown', '--resource-id', 'fixture-device',
    '--resource-dir', resourceDir, '--confirmation', 'server-idle-confirmed', '--json'], dir);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).method, 'user_confirmation'); noResearchStorage(dir);
});
