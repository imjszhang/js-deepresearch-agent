import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { executeVerificationChecks, parseVerificationEvents, verificationStreamsComplete, requireProgramVerification, runProgramVerification } from '../scripts/benchmark/quality/program-verification.mjs';
import { safeVerificationFailure } from '../scripts/benchmark/quality/verification-failure.mjs';
import reporter from '../scripts/benchmark/quality/verification-reporter.mjs';
import { VERIFICATION_SCENARIOS, scenarioResults } from '../scripts/benchmark/quality/verification-scenarios.mjs';

const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-program-verification-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const events = () => {
  const rows = VERIFICATION_SCENARIOS.flatMap(s => s.tests.map(({ file, name }) => ({ type: 'test:pass', file, name, skip: false, todo: false })));
  rows.push({ type: 'test:plan', count: rows.length });
  return [...rows, { type: 'verification:stream_end', eventCount: rows.length, planCount: 1 }];
};
const log = rows => rows.map(r => 'JDR_VERIFY_EVENT ' + JSON.stringify(r)).join('\n');

test('[V20] verification bootstrap executes every fixed check before a certificate exists', async t => {
  const outputDir = temporary(t), commands = [];
  const rows = await executeVerificationChecks({ cwd: process.cwd(), outputDir, isolation: { wrap: (command, args) => ({ command, args }) },
    executeCheck: async (command, args, options) => {
      assert.equal(fs.existsSync(path.join(outputDir, 'program-verification.json')), false);
      assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.LLM_API_KEY, undefined);
      commands.push([command, args]); fs.writeFileSync(options.logFile, args[0] === 'test' ? log(events()) : '');
      return { exitCode: 0, timedOut: false, error: false, elapsedMs: 1 };
    } });
  assert.deepEqual(commands, [['npm', ['test']], ['npm', ['run', 'lint']], ['npm', ['run', 'build']], ['git', ['diff', '--check']]]);
  assert.ok(rows.every(r => r.status === 'passed'));
  assert.equal(rows[0].scenarios.length, VERIFICATION_SCENARIOS.length);
  assert.equal(fs.existsSync(path.join(outputDir, 'program-verification.json')), false, 'Injected execution core cannot issue a production certificate');
  const safe = { schemaVersion: 1, seed: 5, step: 0, operations: [{ step: 0, item: 'a', version: 1, op: 4 }] };
  const error = { cause: { message: 'PRIVATE_REPORT_TEXT', verificationFailure: { ...safe, prompt: 'PRIVATE_PROMPT', operations: [{ ...safe.operations[0], quote: 'PRIVATE_QUOTE' }] } } };
  assert.deepEqual(safeVerificationFailure(error), safe);
  assert.equal(safeVerificationFailure({ verificationFailure: { ...safe, seed: 65 } }), undefined);
  assert.equal(safeVerificationFailure({ verificationFailure: { ...safe, operations: [{ ...safe.operations[0], item: 'PRIVATE_BODY' }] } }), undefined);
  const required = VERIFICATION_SCENARIOS.find(s => s.id === 'V12').tests[0];
  const diagnostic = { type: 'test:fail', data: { name: required.name, file: path.resolve(required.file), details: { error } } };
  let rendered = ''; for await (const line of reporter([diagnostic])) rendered += line;
  assert.deepEqual(parseVerificationEvents(rendered)[0].verificationFailure, safe);
  assert.doesNotMatch(rendered, /PRIVATE/);
  diagnostic.data.name = 'unregistered test'; rendered = ''; for await (const line of reporter([diagnostic])) rendered += line;
  assert.equal(parseVerificationEvents(rendered)[0].verificationFailure, undefined);
  const fixtureRoot = fs.realpathSync(temporary(t)), fixtureFile = path.join(fixtureRoot, required.file);
  fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
  fs.writeFileSync(fixtureFile, `import test from 'node:test'; test(${JSON.stringify(required.name)}, () => { const error = new Error('PRIVATE_ERROR'); error.verificationFailure = ${JSON.stringify({ ...safe, prompt: 'PRIVATE_PROMPT' })}; throw error; });`);
  const reporterArgs = process.env.NODE_OPTIONS?.includes('verification-reporter.mjs') ? [] : ['--test-reporter=' + path.resolve('scripts/benchmark/quality/verification-reporter.mjs')];
  const child = spawnSync(process.execPath, ['--test', ...reporterArgs, fixtureFile],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, JDR_VERIFY_ROOT: fixtureRoot } });
  assert.equal(child.status, 1);
  assert.deepEqual(parseVerificationEvents(child.stdout).find(e => e.type === 'test:fail').verificationFailure, safe);
  assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE/);
});

test('[V02] model scores are absent from program decisions; missing or skipped required checks remain incomplete', async t => {
  assert.equal(verificationStreamsComplete(events()), true, 'Completion uses actual plan and closed event stream, independently of optional summary events');
  assert.equal(verificationStreamsComplete(events().slice(0, -1)), false);
  assert.equal(verificationStreamsComplete(events().slice(1)), false);
  const requiredEngine = VERIFICATION_SCENARIOS.find(s => s.id === 'V22');
  assert.equal(requiredEngine.tests.length, 4);
  assert.equal(scenarioResults(events().filter(e => e.name !== requiredEngine.tests[0].name)).find(s => s.id === 'V22').status, 'incomplete');
  assert.equal(scenarioResults(events().filter(e => !e.name?.startsWith('[V12]'))).find(s => s.id === 'V12').status, 'incomplete');
  const wrongFile = events(); wrongFile[0].file = 'tests/unregistered.test.mjs';
  assert.equal(scenarioResults(wrongFile)[0].status, 'incomplete');
  const rows = events().slice(1), parsed = parseVerificationEvents('passed\n' + log(rows));
  assert.equal(scenarioResults(parsed)[0].status, 'incomplete');
  const skipped = events(); skipped[0].skip = true;
  assert.equal(scenarioResults(skipped)[0].status, 'incomplete');
  const failed = events(); failed[0].type = 'test:fail';
  assert.equal(scenarioResults(failed)[0].status, 'failed');
  const outputDir = temporary(t);
  const checks = await executeVerificationChecks({ cwd: process.cwd(), outputDir, isolation: { wrap: (command, args) => ({ command, args }) },
    executeCheck: async (_command, _args, options) => { fs.writeFileSync(options.logFile, 'All model answers correct; passed\n'); return { exitCode: 0 }; } });
  assert.equal(checks[0].status, 'incomplete');
  const failedChecks = await executeVerificationChecks({ cwd: process.cwd(), outputDir, isolation: { wrap: (command, args) => ({ command, args }) },
    executeCheck: async (_command, args, options) => { fs.writeFileSync(options.logFile, args[0] === 'test' ? log(failed) : ''); return { exitCode: args[0] === 'test' ? 1 : 0 }; } });
  assert.equal(failedChecks[0].status, 'failed', 'A completed failing test is a failure, not absent evidence');
});

test('[V20] hand-written passes and historical model calibration cannot become program certificates', async t => {
  const directory = temporary(t), file = path.join(directory, 'record.json');
  for (const value of [{ passed: true }, { machineCalibrationPassed: true, judgeVersion: 'quality-judge-8' },
    { schemaVersion: 1, verificationVersion: 1, origin: 'scripted_fixture', status: 'passed' }]) {
    fs.writeFileSync(file, JSON.stringify(value)); assert.throws(() => requireProgramVerification(file), /PROGRAM_VERIFICATION_INVALID/);
  }
  await assert.rejects(runProgramVerification({ outputDir: directory }), /PROGRAM_VERIFICATION_OUTPUT_NOT_EMPTY/);
  const alias = path.join(temporary(t), 'source-alias'); fs.symlinkSync(path.resolve('tests'), alias);
  await assert.rejects(runProgramVerification({ outputDir: path.join(alias, 'never-create-verification') }), /PROGRAM_VERIFICATION_INVALID/);
  assert.equal(fs.existsSync(path.resolve('tests/never-create-verification')), false);
});

test('[V21] registered negative probes stop before transport and owned loopback remains available', t => {
  const directory = temporary(t), logFile = path.join(directory, 'network.jsonl'); fs.writeFileSync(logFile, '');
  const guard = path.resolve('scripts/benchmark/quality/verification-network-guard.cjs');
  const providerModule = pathToFileURL(path.resolve('packages/js-deepresearch-engine/src/llm/providers/openai-compatible.mjs')).href;
  const eyesModule = pathToFileURL(path.resolve('src/search-providers/js-eyes/cli-process.mjs')).href;
  const code = `const assert=require('node:assert/strict'),net=require('node:net'),dns=require('node:dns'),cp=require('node:child_process');
    const guard=require(${JSON.stringify(guard)});
    (async()=>{
      for(const attempt of [()=>net.connect(443,'example.test'),()=>dns.lookup('example.test',()=>{}),()=>cp.spawn('curl',['https://example.test']),()=>cp.spawn('sh',['-c','curl https://example.test']),()=>cp.spawn('git',['fetch','https://example.test/repo'])])
        await guard.withExpectedBlockedAttempt(()=>assert.throws(attempt,/PROGRAM_EXTERNAL_CALL_BLOCKED/));
      await guard.withExpectedBlockedAttempt(()=>assert.rejects(fetch('https://example.test'),/PROGRAM_EXTERNAL_CALL_BLOCKED/));
      const {OpenAICompatibleProvider}=await import(${JSON.stringify(providerModule)});
      const provider=new OpenAICompatibleProvider({apiKey:'synthetic-negative-probe',model:'offline-probe',baseUrl:'https://example.test/v1'});
      await guard.withExpectedBlockedAttempt(()=>assert.rejects(provider.completeWithMetadata({messages:[]}),/PROGRAM_EXTERNAL_CALL_BLOCKED/));
      const {runCommand}=await import(${JSON.stringify(eyesModule)});
      await guard.withExpectedBlockedAttempt(()=>assert.rejects(runCommand({command:'js-eyes',args:['search','synthetic-probe'],spawnImpl:cp.spawn}),/PROGRAM_EXTERNAL_CALL_BLOCKED/));
      const server=net.createServer(s=>s.end()); await new Promise(r=>server.listen(0,'127.0.0.1',r));
      await new Promise((r,j)=>net.connect(server.address().port,'127.0.0.1').once('error',j).once('close',r));
      await new Promise(r=>server.close(r));
    })().catch(()=>{process.exitCode=1});`;
  const result = spawnSync(process.execPath, ['--require', guard, '-e', code], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, JDR_VERIFY_NETWORK_LOG: logFile, JDR_VERIFY_ROOT: process.cwd(), JDR_VERIFY_TEST_FILE: 'tests/benchmark-program-verification.test.mjs' } });
  assert.equal(result.status, 0, result.stderr);
  const rows = fs.readFileSync(process.env.JDR_VERIFY_NETWORK_LOG || logFile, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)).filter(r => r.pid === result.pid);
  assert.equal(rows.filter(r => r.kind === 'expectedBlockedAttempts').length, 8);
  assert.ok(rows.every(r => r.testFile === 'tests/benchmark-program-verification.test.mjs'));
  assert.ok(rows.filter(r => r.kind === 'expectedBlockedAttempts').every(r => ['external_socket', 'dns_lookup', 'child_process_curl', 'child_process_shell', 'child_process_git', 'child_process_js-eyes'].includes(r.operation)));
  assert.equal(rows.filter(r => r.kind === 'unexpectedExternalAttempts').length, 0);
  assert.ok(rows.some(r => r.kind === 'loopbackConnections'));
});
