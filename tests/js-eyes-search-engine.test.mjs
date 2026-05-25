import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import {
  JsEyesCliSearchEngine,
  mergeSkillResults,
  parseJsEyesSkills,
  resolveCliCommand,
  resolveJsEyesSkills,
  resolveSpawnTarget,
} from '../src/search/engines/js-eyes.mjs';

describe('JsEyesCliSearchEngine', () => {
  it('runs the JS Eyes CLI with argv and normalizes Zhihu results', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 2,
      jsEyesCli: 'custom-js-eyes',
      jsEyesSkill: 'js-zhihu-ops-skill',
      jsEyesServerUrl: 'ws://127.0.0.1:18080',
      jsEyesMaxPages: 3,
      jsEyesTimeoutMs: 5000,
      jsEyesArgs: { type: 'content' },
    }, {
      spawn: createMockSpawn({
        calls,
        stdout: JSON.stringify({
          ok: true,
          result: {
            data: {
              items: [
                { title: 'Result A', url: 'https://example.com/a', excerpt: 'Excerpt A', type: 'answer' },
                { title: 'Result B', url: 'https://example.com/b', excerpt: 'Excerpt B' },
              ],
            },
          },
        }),
      }),
    });

    const results = await engine.search('AI agent');

    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'skill',
      'run',
      'js-zhihu-ops-skill',
      'search',
      'AI agent',
      '--limit',
      '2',
      '--quiet',
      '--max-pages',
      '3',
      '--ws-endpoint',
      'ws://127.0.0.1:18080',
      '--timeout-ms',
      '5000',
      '--type',
      'content',
    ]);
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(results, [
      {
        title: 'Result A',
        url: 'https://example.com/a',
        snippet: 'Excerpt A\nType: answer',
        engine: 'js-eyes:zhihu',
      },
      {
        title: 'Result B',
        url: 'https://example.com/b',
        snippet: 'Excerpt B',
        engine: 'js-eyes:zhihu',
      },
    ]);
  });

  it('normalizes Xiaohongshu note results', async () => {
    const engine = new JsEyesCliSearchEngine({
      maxResults: 5,
      jsEyesSkill: 'js-xiaohongshu-ops-skill',
    }, {
      spawn: createMockSpawn({
        stdout: JSON.stringify({
          ok: true,
          result: {
            notes: [
              {
                title: 'Note A',
                url: 'https://www.xiaohongshu.com/explore/a',
                desc: 'Note body',
                author: 'Alice',
                likeCount: 42,
              },
            ],
          },
        }),
      }),
    });

    const results = await engine.search('穿搭');

    assert.deepEqual(results, [
      {
        title: 'Note A',
        url: 'https://www.xiaohongshu.com/explore/a',
        snippet: 'Note body\nAuthor: Alice\nLikes: 42',
        engine: 'js-eyes:xhs',
      },
    ]);
  });

  it('throws with stderr context when the CLI exits non-zero', async () => {
    const engine = new JsEyesCliSearchEngine({}, {
      spawn: createMockSpawn({
        code: 1,
        stderr: 'skill is not enabled',
      }),
    });

    await assert.rejects(
      () => engine.search('query'),
      /failed for all skills.*exited with code 1: skill is not enabled/,
    );
  });

  it('throws when stdout is not JSON', async () => {
    const engine = new JsEyesCliSearchEngine({}, {
      spawn: createMockSpawn({ stdout: 'not-json' }),
    });

    await assert.rejects(
      () => engine.search('query'),
      /invalid JSON/,
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

  it('kills the CLI on timeout', async () => {
    const child = createMockChild();
    const engine = new JsEyesCliSearchEngine({ jsEyesTimeoutMs: 1 }, {
      spawn: () => child,
    });

    const promise = engine.search('query');
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit('close', null, 'SIGTERM');

    await assert.rejects(promise, /timed out/);
    assert.equal(child.killed, true);
  });

  it('runs multiple skills serially and interleaves merged results', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 3,
      jsEyesSkills: ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    }, {
      spawn: createSkillAwareMockSpawn({
        calls,
        responses: {
          'js-zhihu-ops-skill': {
            ok: true,
            result: {
              data: {
                items: [
                  { title: 'Zhihu A', url: 'https://example.com/zhihu-a', excerpt: 'A' },
                  { title: 'Zhihu B', url: 'https://example.com/zhihu-b', excerpt: 'B' },
                ],
              },
            },
          },
          'js-xiaohongshu-ops-skill': {
            ok: true,
            result: {
              notes: [
                { title: 'XHS A', url: 'https://example.com/xhs-a', desc: 'XHS A' },
                { title: 'XHS B', url: 'https://example.com/xhs-b', desc: 'XHS B' },
              ],
            },
          },
        },
      }),
    });

    const results = await engine.search('AI agent');

    assert.equal(calls.length, 2);
    const firstRunIndex = calls[0].args.indexOf('run');
    const secondRunIndex = calls[1].args.indexOf('run');
    assert.equal(calls[0].args[firstRunIndex + 1], 'js-zhihu-ops-skill');
    assert.equal(calls[1].args[secondRunIndex + 1], 'js-xiaohongshu-ops-skill');
    assert.deepEqual(results.map((item) => item.url), [
      'https://example.com/zhihu-a',
      'https://example.com/xhs-a',
      'https://example.com/zhihu-b',
    ]);
    assert.deepEqual(results.map((item) => item.engine), [
      'js-eyes:zhihu',
      'js-eyes:xhs',
      'js-eyes:zhihu',
    ]);
  });

  it('deduplicates URLs across skills', async () => {
    const engine = new JsEyesCliSearchEngine({
      maxResults: 8,
      jsEyesSkills: ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    }, {
      spawn: createSkillAwareMockSpawn({
        responses: {
          'js-zhihu-ops-skill': {
            ok: true,
            result: {
              data: {
                items: [{ title: 'Shared', url: 'https://example.com/shared', excerpt: 'Zhihu' }],
              },
            },
          },
          'js-xiaohongshu-ops-skill': {
            ok: true,
            result: {
              notes: [{ title: 'Shared', url: 'https://example.com/shared', desc: 'XHS' }],
            },
          },
        },
      }),
    });

    const results = await engine.search('query');

    assert.equal(results.length, 1);
    assert.equal(results[0].engine, 'js-eyes:zhihu');
  });

  it('returns partial results when one skill fails', async () => {
    const engine = new JsEyesCliSearchEngine({
      jsEyesSkills: ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    }, {
      spawn: createSkillAwareMockSpawn({
        responses: {
          'js-zhihu-ops-skill': {
            ok: true,
            result: {
              data: {
                items: [{ title: 'Zhihu only', url: 'https://example.com/zhihu', excerpt: 'ok' }],
              },
            },
          },
          'js-xiaohongshu-ops-skill': {
            code: 1,
            stderr: 'skill is not enabled',
          },
        },
      }),
    });

    const results = await engine.search('query');

    assert.deepEqual(results, [{
      title: 'Zhihu only',
      url: 'https://example.com/zhihu',
      snippet: 'ok',
      engine: 'js-eyes:zhihu',
    }]);
  });

  it('rejects when all skills fail', async () => {
    const engine = new JsEyesCliSearchEngine({
      jsEyesSkills: ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    }, {
      spawn: createSkillAwareMockSpawn({
        responses: {
          'js-zhihu-ops-skill': { code: 1, stderr: 'zhihu failed' },
          'js-xiaohongshu-ops-skill': { code: 1, stderr: 'xhs failed' },
        },
      }),
    });

    await assert.rejects(
      () => engine.search('query'),
      /failed for all skills.*js-zhihu-ops-skill.*js-xiaohongshu-ops-skill/,
    );
  });

  it('does not start the next skill after abort', async () => {
    const calls = [];
    const controller = new AbortController();
    const child = createMockChild();
    const engine = new JsEyesCliSearchEngine({
      jsEyesSkills: ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    }, {
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
    });

    const promise = engine.search('query', { signal: controller.signal });
    controller.abort();

    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(calls.length, 1);
    assert.equal(child.killed, true);
  });
});

describe('JS Eyes skill parsing', () => {
  it('parses comma-separated skill lists', () => {
    assert.deepEqual(
      parseJsEyesSkills('js-zhihu-ops-skill,js-xiaohongshu-ops-skill'),
      ['js-zhihu-ops-skill', 'js-xiaohongshu-ops-skill'],
    );
  });

  it('trims, deduplicates, and ignores empty entries', () => {
    assert.deepEqual(
      parseJsEyesSkills(' a , a ; b '),
      ['a', 'b'],
    );
  });

  it('falls back to the default skill when empty', () => {
    assert.deepEqual(parseJsEyesSkills(''), ['js-zhihu-ops-skill']);
    assert.deepEqual(parseJsEyesSkills(undefined), ['js-zhihu-ops-skill']);
  });

  it('resolves skills from config arrays or strings', () => {
    assert.deepEqual(
      resolveJsEyesSkills({ jsEyesSkills: ['js-xiaohongshu-ops-skill'] }),
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
    const target = resolveSpawnTarget('C:\\tools\\js-eyes.cmd', ['skill', 'run'], {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    });

    assert.equal(target.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(target.args, ['/d', '/s', '/c', 'C:\\tools\\js-eyes.cmd', 'skill', 'run']);
  });

  it('spawns Unix executables directly without cmd.exe', () => {
    const target = resolveSpawnTarget('/usr/local/bin/js-eyes', ['skill', 'run'], {
      platform: 'linux',
    });

    assert.equal(target.command, '/usr/local/bin/js-eyes');
    assert.deepEqual(target.args, ['skill', 'run']);
  });
});

function createSkillAwareMockSpawn({ calls = [], responses = {} } = {}) {
  return (command, args, options) => {
    calls?.push({ command, args, options });
    const runIndex = args.indexOf('run');
    const skill = runIndex >= 0 ? args[runIndex + 1] : args[2];
    const response = responses[skill] || {};
    const child = createMockChild();

    queueMicrotask(() => {
      if (response.stderr) child.stderr.emit('data', response.stderr);
      if (response.stdout) {
        child.stdout.emit('data', response.stdout);
      } else if (response.ok !== undefined || response.result !== undefined) {
        child.stdout.emit('data', JSON.stringify(response));
      }
      child.emit('close', response.code ?? 0, null);
    });

    return child;
  };
}

function createMockSpawn({ calls = [], stdout = '', stderr = '', code = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = createMockChild();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code, null);
    });
    return child;
  };
}

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}
