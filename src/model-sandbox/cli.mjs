import fs from 'node:fs';
import path from 'node:path';
import { readSandboxPlan } from './plan.mjs';

const VALUE_FLAGS = {
  plan: ['provider', 'model', 'base-url', 'resource-id', 'suite', 'seed', 'repeats', 'input-chars', 'output-tokens',
    'concurrency', 'max-tokens', 'temperature', 'cancel-after-ms', 'stability-requests', 'queue-timeout-ms',
    'headers-timeout-ms', 'first-event-timeout-ms', 'idle-timeout-ms', 'total-timeout-ms', 'max-requests',
    'max-duration-ms', 'max-response-bytes', 'output'],
  run: ['plan-file', 'output-dir', 'resource-dir', 'provider', 'model', 'base-url'],
  replay: ['call', 'mode', 'base-url', 'provider', 'model', 'resource-id', 'resource-dir', 'output-dir'],
  inspect: [],
  compare: [],
  'resolve-unknown': ['resource-dir', 'resource-id', 'confirmation'],
};
const BOOLEAN_FLAGS = new Set(['json', 'help', 'live']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function parseArguments(argv) {
  const command = argv[0] || 'help';
  if (command === 'help' || command === '--help') {
    if (argv.length > 1) fail('SANDBOX_ARGUMENT_INVALID');
    return { command: 'help', flags: {}, args: [] };
  }
  const allowed = VALUE_FLAGS[command];
  if (!allowed) fail('SANDBOX_COMMAND_INVALID');
  const flags = {}, args = [];
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('-')) { args.push(argument); continue; }
    if (!argument.startsWith('--')) fail('SANDBOX_ARGUMENT_INVALID');
    const key = argument.slice(2);
    if (Object.hasOwn(flags, key) || !allowed.includes(key) && !BOOLEAN_FLAGS.has(key)) fail('SANDBOX_ARGUMENT_INVALID');
    if (BOOLEAN_FLAGS.has(key)) {
      if (key === 'live' && !['run', 'replay'].includes(command)) fail('SANDBOX_ARGUMENT_INVALID');
      flags[key] = true;
    } else {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value === '') fail('SANDBOX_ARGUMENT_INVALID');
      flags[key] = value;
    }
  }
  const count = { plan: 0, run: 0, replay: 1, inspect: 1, compare: 2, 'resolve-unknown': 0 }[command];
  if (!flags.help && args.length !== count) fail('SANDBOX_ARGUMENT_INVALID');
  return { command, flags, args };
}

function integer(value, minimum = 1) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail('SANDBOX_ARGUMENT_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail('SANDBOX_ARGUMENT_INVALID');
  return parsed;
}

function endpointIdentity(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('SANDBOX_ARGUMENT_INVALID');
    return url.href.replace(/\/+$/, '');
  } catch { return fail('SANDBOX_ARGUMENT_INVALID'); }
}

function planOptions(flags, env) {
  const provider = flags.provider || env.LLM_PROVIDER || 'openai-compatible';
  const options = {
    provider,
    model: flags.model || env.LLM_MODEL,
    baseUrl: flags['base-url'] || (provider === 'ollama' ? env.OLLAMA_BASE_URL : env.OPENAI_BASE_URL),
  };
  if (!options.model || !options.baseUrl) fail('SANDBOX_CONFIGURATION_REQUIRED');
  options.baseUrl = endpointIdentity(options.baseUrl);
  for (const [flag, key] of [['resource-id', 'resourceId'], ['suite', 'suite'], ['seed', 'seed']]) {
    if (flags[flag] !== undefined) options[key] = flags[flag];
  }
  for (const [flag, key, min] of [['repeats', 'repetitions', 1], ['max-tokens', 'maxTokens', 0],
    ['cancel-after-ms', 'cancelAfterMs', 1], ['stability-requests', 'stabilityRequests', 1]]) {
    if (flags[flag] !== undefined) options[key] = integer(flags[flag], min);
  }
  for (const [flag, key] of [['input-chars', 'inputChars'], ['output-tokens', 'outputTokens'], ['concurrency', 'concurrencyLevels']]) {
    if (flags[flag] !== undefined) options[key] = flags[flag].split(',').map(value => integer(value));
  }
  if (flags.temperature !== undefined) {
    const value = Number(flags.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) fail('SANDBOX_ARGUMENT_INVALID');
    options.temperature = value;
  }
  for (const [group, mappings] of [
    ['timeouts', [['queue-timeout-ms', 'queueMs'], ['headers-timeout-ms', 'headersMs'], ['first-event-timeout-ms', 'firstEventMs'],
      ['idle-timeout-ms', 'idleMs'], ['total-timeout-ms', 'totalMs']]],
    ['limits', [['max-requests', 'maxRequests'], ['max-duration-ms', 'maxDurationMs'], ['max-response-bytes', 'maxResponseBytes']]],
  ]) {
    const values = {};
    for (const [flag, key] of mappings) if (flags[flag] !== undefined) values[key] = integer(flags[flag]);
    if (Object.keys(values).length) options[group] = values;
  }
  return options;
}

function assertFrozenIdentity(plan, flags) {
  for (const key of ['provider', 'model']) {
    if (flags[key] !== undefined && flags[key] !== plan[key]) fail('SANDBOX_IDENTITY_MISMATCH');
  }
  if (flags['base-url'] !== undefined && endpointIdentity(flags['base-url']) !== endpointIdentity(plan.baseUrl)) fail('SANDBOX_IDENTITY_MISMATCH');
}

function readPlan(file) {
  if (!file) fail('SANDBOX_PLAN_REQUIRED');
  return readSandboxPlan(path.resolve(file));
}

function safeEvent(event) {
  const safe = {};
  for (const key of ['type', 'stage', 'status', 'callId', 'caseId', 'code']) {
    const value = event?.[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value)) safe[key] = value;
  }
  for (const key of ['elapsedMs', 'durationMs', 'queueMs', 'receivedBytes', 'contentChars', 'eventCount', 'activeRequests']) {
    if (Number.isFinite(event?.[key]) && event[key] >= 0) safe[key] = event[key];
  }
  for (const key of ['transportComplete', 'executionResolved', 'structureAccepted']) {
    if (typeof event?.[key] === 'boolean') safe[key] = event[key];
  }
  return safe;
}

function resultExitCode(result) {
  const status = result?.summary?.status || result?.status;
  if (['unknown', 'outcome_unknown', 'execution_unknown'].includes(status)) return 2;
  if (status === 'cancelled') return 130;
  if (['failed', 'incomplete'].includes(status)) return 1;
  return 0;
}

function printHelp(write) {
  write(`Local model sandbox (independent of research history and quality calibration)
Commands:
  model-sandbox plan --provider openai-compatible|ollama --model <name> --base-url <url> [--suite baseline] [--output <plan.json>]
  model-sandbox run --plan-file <plan.json> --live [--output-dir <new-directory>] [--resource-dir <directory>] [--json]
  model-sandbox replay <sessionDir> --call <llm-id> --mode exact|stream --base-url <url> --live [--output-dir <new-directory>] [--json]
  model-sandbox inspect <runDir> [--json]
  model-sandbox compare <runDirA> <runDirB> [--json]
  model-sandbox resolve-unknown --resource-id <id> --confirmation server-idle-confirmed [--resource-dir <directory>] [--json]
Plan options:
  --suite <name> --seed <value> --repeats <n> --input-chars <n,n> --output-tokens <n,n> --concurrency <n,n>
  --resource-id <id> --max-tokens <n> --temperature <n> --cancel-after-ms <n> --stability-requests <n>
  --queue-timeout-ms <n> --headers-timeout-ms <n> --first-event-timeout-ms <n> --idle-timeout-ms <n> --total-timeout-ms <n>
  --max-requests <n> --max-duration-ms <n> --max-response-bytes <n>
Configuration: flags and LLM_PROVIDER / LLM_MODEL / OPENAI_BASE_URL / OLLAMA_BASE_URL only.
Credentials: current OPENAI_API_KEY (optional); proxy: current JDR_HTTP_PROXY. Credentials are never written into plans.
Run uses the frozen plan endpoint and model. Explicit identity overrides must match the plan.
No request is sent without --live. Resolve unknown only after confirming the server has stopped the earlier request.`);
}

export async function runModelSandboxCli(argv, {
  env = process.env, stdout = line => console.log(line), stderr = line => console.error(line),
} = {}) {
  let abort;
  try {
    const { command, flags, args } = parseArguments(argv);
    if (command === 'help' || flags.help) { printHelp(stdout); return 0; }
    if (['run', 'replay'].includes(command) && !flags.live) fail('SANDBOX_LIVE_REQUIRED');
    const { createSandboxPlan, validateSandboxPlan, planIdentity } = await import('./plan.mjs');
    const emit = value => stdout(JSON.stringify(value, null, 2));
    if (command === 'plan') {
      const plan = createSandboxPlan(planOptions(flags, env));
      validateSandboxPlan(plan);
      if (flags.output) {
        const file = path.resolve(flags.output);
        fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        emit({ planFile: file, planHash: planIdentity(plan) });
      } else emit(plan);
      return 0;
    }
    if (command === 'inspect' || command === 'compare') {
      const { inspectSandbox, compareSandboxes } = await import('./artifacts.mjs');
      emit(command === 'inspect' ? await inspectSandbox(path.resolve(args[0])) : await compareSandboxes(path.resolve(args[0]), path.resolve(args[1])));
      return 0;
    }
    const resourceDir = path.resolve(flags['resource-dir'] || 'work_dir/model-sandbox/.resources');
    if (command === 'resolve-unknown') {
      if (!flags['resource-id'] || flags.confirmation !== 'server-idle-confirmed') fail('SANDBOX_CONFIRMATION_REQUIRED');
      const { resolveUnknownResource } = await import('./resource.mjs');
      emit(await resolveUnknownResource({ resourceDir, resourceId: flags['resource-id'], confirmation: flags.confirmation }));
      return 0;
    }
    const { runSandbox, createReplayPlan } = await import('./runner.mjs');
    let plan;
    if (command === 'replay') {
      if (!flags.call || !['exact', 'stream'].includes(flags.mode)) fail('SANDBOX_ARGUMENT_INVALID');
      const provider = flags.provider || env.LLM_PROVIDER;
      const baseUrl = flags['base-url'] || (provider === 'ollama' ? env.OLLAMA_BASE_URL : env.OPENAI_BASE_URL);
      if (!baseUrl) fail('SANDBOX_CONFIGURATION_REQUIRED');
      plan = await createReplayPlan({ sessionDir: path.resolve(args[0]), callId: flags.call, mode: flags.mode,
        baseUrl: endpointIdentity(baseUrl), ...(flags['resource-id'] ? { resourceId: flags['resource-id'] } : {}) });
    } else plan = readPlan(flags['plan-file']);
    validateSandboxPlan(plan);
    assertFrozenIdentity(plan, flags);
    const controller = new AbortController();
    abort = () => controller.abort();
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    const result = await runSandbox({ plan, outputDir: flags['output-dir'] && path.resolve(flags['output-dir']),
      resourceDir, apiKey: env.OPENAI_API_KEY || '', proxy: env.JDR_HTTP_PROXY || '', signal: controller.signal,
      onEvent: event => { const safe = safeEvent(event); if (Object.keys(safe).length) stderr(JSON.stringify(safe)); } });
    emit(result);
    return resultExitCode(result);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^SANDBOX_[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'SANDBOX_COMMAND_FAILED';
    stderr(code);
    return error?.name === 'AbortError' || code === 'SANDBOX_CANCELLED' ? 130 : 1;
  } finally {
    if (abort) { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
  }
}
