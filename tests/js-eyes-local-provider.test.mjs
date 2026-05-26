import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { resolveSearchConcurrency } from 'js-deepresearch-engine';
import {
  JsEyesCliSearchEngine,
  mergeSkillResults,
  parseJsEyesSkills,
  parseProviderSkills,
  resolveCliCommand,
  resolveJsEyesSkills,
  resolveProviderConfig,
  resolveSpawnTarget,
  runCommand,
  buildZhihuReadCommand,
  classifyZhihuUrl,
  createZhihuContentFetchHandler,
  parseZhihuReadPayload,
} from '../src/search-providers/js-eyes/public.mjs';

describe('JsEyesCliSearchEngine', () => {
  it('uses local skill-run driver for zhihu without the missing unified command', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 2,
      jsEyesCli: 'custom-js-eyes',
      jsEyesSkill: 'js-zhihu-ops-skill',
      jsEyesServerUrl: 'ws://127.0.0.1:18080',
      jsEyesMaxPages: 1,
      jsEyesTimeoutMs: 5000,
    }, {
      spawn: createMockSpawn({
        calls,
        stdout: JSON.stringify({
          ok: true,
          result: {
            items: [
              {
                title: 'OpenClaw @openclaw',
                url: 'https://www.zhihu.com/question/1/answer/1',
                excerpt: 'OpenClaw release',
              },
              {
                title: 'Example @example',
                url: 'https://www.zhihu.com/question/2/answer/2',
                excerpt: 'Another tweet',
              },
            ],
          },
        }),
      }),
    });

    const results = await engine.search('openclaw');

    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'skill',
      'run',
      'js-zhihu-ops-skill',
      'search',
      'openclaw',
      '--limit',
      '2',
      '--max-pages',
      '1',
      '--ws-endpoint',
      'ws://127.0.0.1:18080',
      '--quiet',
    ]);
    assert.deepEqual(results, [
      {
        title: 'OpenClaw @openclaw',
        url: 'https://www.zhihu.com/question/1/answer/1',
        snippet: 'OpenClaw release',
        engine: 'js-eyes:zhihu',
      },
      {
        title: 'Example @example',
        url: 'https://www.zhihu.com/question/2/answer/2',
        snippet: 'Another tweet',
        engine: 'js-eyes:zhihu',
      },
    ]);
  });

  it('uses local skill-run driver for X without the missing unified command', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 5,
      jsEyesCli: 'custom-js-eyes',
      provider: {
        skills: ['js-x-ops-skill'],
        serverUrl: 'ws://127.0.0.1:18080',
        maxPages: 1,
      },
    }, {
      spawn: createMockSpawn({
        calls,
        stdout: [
          JSON.stringify({ ok: true }),
          JSON.stringify({
            ok: true,
            result: {
              tweets: [
                {
                  title: 'AI agent discussion',
                  url: 'https://x.com/example/status/1',
                  text: 'Deep Research agents are trending',
                },
              ],
            },
          }),
        ],
      }),
    });

    const results = await engine.search('AI Agent Deep Research');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'skill',
      'run',
      'js-x-ops-skill',
      'navigate-search',
      'AI Agent Deep Research',
      '--ws-endpoint',
      'ws://127.0.0.1:18080',
    ]);
    assert.deepEqual(calls[1].args, [
      'skill',
      'run',
      'js-x-ops-skill',
      'search',
      'AI Agent Deep Research',
      '--max-tweets',
      '5',
      '--max-pages',
      '1',
      '--ws-endpoint',
      'ws://127.0.0.1:18080',
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].engine, 'js-eyes:x');
    assert.match(results[0].url, /x\.com/);
  });

  it('uses local skill-run driver for reddit without unified flags', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 5,
      jsEyesCli: 'custom-js-eyes',
      provider: {
        skills: ['js-reddit-ops-skill'],
        serverUrl: 'ws://127.0.0.1:18080',
      },
    }, {
      spawn: createMockSpawn({
        calls,
        stdout: JSON.stringify({
          ok: true,
          result: {
            items: [
              {
                title: 'OpenClaw on Reddit',
                url: 'https://www.reddit.com/r/openclaw/comments/1/test/',
                author: 'tester',
                selftext: 'Discussion thread',
              },
            ],
          },
        }),
      }),
    });

    const results = await engine.search('openclaw');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'skill',
      'run',
      'js-reddit-ops-skill',
      'search',
      'openclaw',
      '--limit',
      '5',
      '--ws-endpoint',
      'ws://127.0.0.1:18080',
      '--read-mode',
      'api',
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].engine, 'js-eyes:reddit');
    assert.match(results[0].url, /reddit\.com/);
  });

  it('exposes serial browser search capabilities', () => {
    const engine = new JsEyesCliSearchEngine({});
    assert.equal(engine.capabilities.maxQuestionConcurrency, 1);
    assert.equal(resolveSearchConcurrency(engine, { research: { concurrency: 4 } }, 3), 1);
  });

  it('throws with stderr context when the CLI exits non-zero', async () => {
    const engine = new JsEyesCliSearchEngine({}, {
      spawn: createMockSpawn({ stderr: 'skill failed', code: 1 }),
    });

    await assert.rejects(
      () => engine.search('query'),
      /exited with code 1: skill failed/,
    );
  });

  it('throws when stdout is not JSON', async () => {
    const engine = new JsEyesCliSearchEngine({}, {
      spawn: createMockSpawn({ stdout: 'not-json' }),
    });

    await assert.rejects(
      () => engine.search('query'),
      /returned invalid JSON/,
    );
  });

  it('kills the CLI on abort', async () => {
    const controller = new AbortController();
    const child = createMockChild();
    const engine = new JsEyesCliSearchEngine({}, {
      spawn: () => child,
    });

    const promise = engine.search('query', { signal: controller.signal });
    controller.abort();

    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(child.killed, true);
  });

  it('kills the process tree on Windows abort', async () => {
    const controller = new AbortController();
    const killed = [];
    const child = createMockChild({ pid: 4242 });
    child.kill = () => {
      child.killed = true;
    };

    const promise = runCommand({
      command: 'js-eyes',
      args: ['search', 'query'],
      signal: controller.signal,
      spawnImpl: () => child,
      platform: 'win32',
      killProcessTreeImpl: (pid) => {
        killed.push(pid);
      },
    });

    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.deepEqual(killed, [4242]);
  });

  it('stops remaining skills when one skill aborts', async () => {
    const calls = [];
    const controller = new AbortController();

    const engine = new JsEyesCliSearchEngine({
      provider: {
        skills: ['js-reddit-ops-skill', 'js-x-ops-skill'],
        serverUrl: 'ws://127.0.0.1:18080',
      },
    }, {
      spawn: (command, args) => {
        calls.push({ command, args });
        const child = createMockChild();
        queueMicrotask(() => controller.abort());
        return child;
      },
    });

    await assert.rejects(
      () => engine.search('query', { signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls.length, 1);
  });

  it('kills the CLI on timeout', async () => {
    const engine = new JsEyesCliSearchEngine({ jsEyesTimeoutMs: 20 }, {
      spawn: () => createMockChild(),
    });

    await assert.rejects(
      () => engine.search('query'),
      /timed out after 20ms/,
    );
  });
});

describe('JS Eyes skill parsing', () => {
  it('parses comma-separated skill lists', () => {
    assert.deepEqual(
      parseProviderSkills('js-zhihu-ops-skill,js-xiaohongshu-ops-skill'),
      ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    );
    assert.deepEqual(
      parseJsEyesSkills('js-zhihu-ops-skill,js-xiaohongshu-ops-skill'),
      ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    );
  });

  it('trims, deduplicates, and ignores empty entries', () => {
    assert.deepEqual(
      parseProviderSkills(' a , a ; b '),
      ['a', 'b'],
    );
  });

  it('falls back to the default skill when empty', () => {
    assert.deepEqual(parseProviderSkills(''), ['js-zhihu-ops-skill']);
    assert.deepEqual(parseProviderSkills(undefined), ['js-zhihu-ops-skill']);
  });

  it('resolves skills from config arrays or strings', () => {
    assert.deepEqual(
      resolveProviderConfig({ jsEyesSkills: ['js-xiaohongshu-ops-skill'] }).skills,
      ['js-xiaohongshu-ops-skill'],
    );
    assert.deepEqual(
      resolveJsEyesSkills({ jsEyesSkill: 'js-zhihu-ops-skill,js-xiaohongshu-ops-skill' }),
      ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    );
  });
});

describe('mergeSkillResults', () => {
  it('interleaves batches and caps the total', () => {
    const merged = mergeSkillResults([
      [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
      [{ url: 'https://example.com/c' }, { url: 'https://example.com/d' }],
    ], 3);

    assert.deepEqual(merged.map((item) => item.url), [
      'https://example.com/a',
      'https://example.com/c',
      'https://example.com/b',
    ]);
  });
});

describe('Zhihu content fetcher', () => {
  it('classifies zhihu article and answer URLs', () => {
    assert.equal(
      classifyZhihuUrl('https://zhuanlan.zhihu.com/p/2026793291014842204'),
      'article',
    );
    assert.equal(
      classifyZhihuUrl('https://www.zhihu.com/question/1/answer/2'),
      'answer',
    );
    assert.equal(classifyZhihuUrl('https://www.zhihu.com/question/1'), null);
  });

  it('builds skill-run article and answer commands', () => {
    const provider = {
      serverUrl: 'ws://127.0.0.1:18080',
      timeoutMs: 45000,
    };

    assert.deepEqual(
      buildZhihuReadCommand('https://zhuanlan.zhihu.com/p/1', 'article', provider),
      [
        'skill', 'run', 'js-zhihu-ops-skill', 'article', 'https://zhuanlan.zhihu.com/p/1',
        '--ws-endpoint', 'ws://127.0.0.1:18080',
        '--timeout-ms', '90000',
        '--json', '--quiet',
      ],
    );
    assert.deepEqual(
      buildZhihuReadCommand('https://www.zhihu.com/question/1/answer/2', 'answer', provider),
      [
        'skill', 'run', 'js-zhihu-ops-skill', 'answer', 'https://www.zhihu.com/question/1/answer/2',
        '--ws-endpoint', 'ws://127.0.0.1:18080',
        '--timeout-ms', '90000',
        '--json', '--quiet',
      ],
    );
  });

  it('maps successful zhihu read payloads to content', () => {
    const parsed = parseZhihuReadPayload({
      ok: true,
      sourceUrl: 'https://zhuanlan.zhihu.com/p/1',
      result: {
        title: 'LLM Wiki article',
        content: 'Karpathy LLM Wiki uses compiler-style RAG.',
      },
    });

    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.title, 'LLM Wiki article');
    assert.match(parsed.content, /compiler-style RAG/);
    assert.equal(parsed.backend, 'js-eyes:zhihu');
  });

  it('reads zhihu article content through js-eyes skill-run', async () => {
    const calls = [];
    const handler = createZhihuContentFetchHandler({
      spawn: createMockSpawn({
        calls,
        stdout: JSON.stringify({
          ok: true,
          sourceUrl: 'https://zhuanlan.zhihu.com/p/1',
          result: {
            title: 'LLM Wiki article',
            content: 'Detailed zhihu article body.',
          },
        }),
      }),
    });

    const result = await handler('https://zhuanlan.zhihu.com/p/1', {
      source: { engine: 'js-eyes:zhihu' },
      settings: {
        search: {
          engine: 'js-eyes',
          provider: {
            cli: 'custom-js-eyes',
            serverUrl: 'ws://127.0.0.1:18080',
            timeoutMs: 45000,
          },
        },
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'skill', 'run', 'js-zhihu-ops-skill', 'article', 'https://zhuanlan.zhihu.com/p/1',
      '--ws-endpoint', 'ws://127.0.0.1:18080',
      '--timeout-ms', '90000',
      '--json', '--quiet',
    ]);
    assert.equal(result.status, 'ok');
    assert.match(result.content, /Detailed zhihu article body/);
  });

  it('returns unsupported for non-zhihu URLs', async () => {
    const handler = createZhihuContentFetchHandler({
      spawn: createMockSpawn({ stdout: '{}' }),
    });

    const result = await handler('https://example.com/page', {
      source: { engine: 'searxng' },
      settings: { search: { engine: 'js-eyes', provider: { serverUrl: 'ws://127.0.0.1:18080' } } },
    });

    assert.equal(result.status, 'unsupported');
  });

  it('returns failed payload errors without throwing', async () => {
    const handler = createZhihuContentFetchHandler({
      spawn: createMockSpawn({
        stdout: JSON.stringify({
          ok: false,
          antiCrawlState: { reason: 'login_required' },
        }),
      }),
    });

    const result = await handler('https://www.zhihu.com/question/1/answer/2', {
      source: { engine: 'js-eyes:zhihu' },
      settings: {
        search: {
          engine: 'js-eyes',
          provider: { serverUrl: 'ws://127.0.0.1:18080' },
        },
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'login_required');
  });
});

describe('JS Eyes CLI resolution', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('resolves Unix executables from PATH', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-js-eyes-unix-'));
    const cliPath = path.join(tempDir, 'js-eyes');
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8');
    fs.chmodSync(cliPath, 0o755);

    const resolved = resolveCliCommand('js-eyes', {
      platform: 'linux',
      pathValue: tempDir,
    });

    assert.equal(resolved, cliPath);
  });

  it('resolves Windows npm shims from PATH', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-js-eyes-win-'));
    const cliPath = path.join(tempDir, 'js-eyes.cmd');
    fs.writeFileSync(cliPath, '@echo off\n', 'utf8');

    const resolved = resolveCliCommand('js-eyes', {
      platform: 'win32',
      pathValue: tempDir,
    });

    assert.equal(resolved, cliPath);
  });

  it('wraps Windows batch shims with cmd.exe', () => {
    const target = resolveSpawnTarget('C:\\tools\\js-eyes.cmd', ['search', 'query'], {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    });

    assert.equal(target.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(target.args, ['/d', '/s', '/c', 'C:\\tools\\js-eyes.cmd', 'search', 'query']);
  });

  it('spawns Unix executables directly without cmd.exe', () => {
    const target = resolveSpawnTarget('/usr/local/bin/js-eyes', ['search', 'query'], {
      platform: 'linux',
    });

    assert.equal(target.command, '/usr/local/bin/js-eyes');
    assert.deepEqual(target.args, ['search', 'query']);
  });
});

function createMockSpawn({ calls = [], stdout = '', stderr = '', code = 0 } = {}) {
  let callIndex = 0;
  return (command, args, options) => {
    calls?.push({ command, args, options });
    const child = createMockChild();
    const stdoutValue = Array.isArray(stdout) ? stdout[callIndex] : stdout;
    const stderrValue = Array.isArray(stderr) ? stderr[callIndex] : stderr;
    const codeValue = Array.isArray(code) ? code[callIndex] : code;
    callIndex += 1;
    queueMicrotask(() => {
      if (stdoutValue) child.stdout.emit('data', stdoutValue);
      if (stderrValue) child.stderr.emit('data', stderrValue);
      child.emit('close', codeValue, null);
    });
    return child;
  };
}

function createMockChild({ pid } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  if (pid !== undefined) child.pid = pid;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.emit('close', null, 'SIGTERM');
    });
  };
  return child;
}
