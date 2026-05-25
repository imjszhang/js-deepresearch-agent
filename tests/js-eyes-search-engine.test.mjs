import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import {
  JsEyesCliSearchEngine,
  resolveCliCommand,
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
      /exited with code 1: skill is not enabled/,
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
