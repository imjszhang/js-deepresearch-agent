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
  parseProviderSkills,
  resolveCliCommand,
  resolveJsEyesSkills,
  resolveProviderConfig,
  resolveSpawnTarget,
} from '../src/search/engines/js-eyes.mjs';
import { resolveSearchConcurrency } from '../src/search/search-capabilities.mjs';

describe('JsEyesCliSearchEngine', () => {
  it('calls the unified js-eyes search facade and normalizes items', async () => {
    const calls = [];
    const engine = new JsEyesCliSearchEngine({
      maxResults: 2,
      jsEyesCli: 'custom-js-eyes',
      jsEyesSkill: 'js-x-ops-skill',
      jsEyesServerUrl: 'ws://127.0.0.1:18080',
      jsEyesMaxPages: 1,
      jsEyesTimeoutMs: 5000,
    }, {
      spawn: createMockSpawn({
        calls,
        stdout: JSON.stringify({
          ok: true,
          query: 'openclaw',
          items: [
            {
              title: 'OpenClaw @openclaw',
              url: 'https://x.com/openclaw/status/1',
              snippet: 'OpenClaw release',
              platform: 'x',
              engine: 'js-eyes:x',
            },
            {
              title: 'Example @example',
              url: 'https://x.com/example/status/2',
              snippet: 'Another tweet',
              platform: 'x',
              engine: 'js-eyes:x',
            },
          ],
        }),
      }),
    });

    const results = await engine.search('openclaw');

    assert.equal(calls[0].command, 'custom-js-eyes');
    assert.deepEqual(calls[0].args, [
      'search',
      'openclaw',
      '--skills',
      'js-x-ops-skill',
      '--max-results',
      '2',
      '--json',
      '--max-pages',
      '1',
      '--server',
      'ws://127.0.0.1:18080',
      '--timeout-ms',
      '5000',
    ]);
    assert.deepEqual(results, [
      {
        title: 'OpenClaw @openclaw',
        url: 'https://x.com/openclaw/status/1',
        snippet: 'OpenClaw release',
        engine: 'js-eyes:x',
      },
      {
        title: 'Example @example',
        url: 'https://x.com/example/status/2',
        snippet: 'Another tweet',
        engine: 'js-eyes:x',
      },
    ]);
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
  return (command, args, options) => {
    calls?.push({ command, args, options });
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
    queueMicrotask(() => {
      child.emit('close', null, 'SIGTERM');
    });
  };
  return child;
}
