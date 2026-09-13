import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

describe('CLI package entry', () => {
  it('publishes both CLI aliases through an executable entry file', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.bin.jdr, 'src/cli.mjs');
    assert.equal(pkg.bin['js-deepresearch-agent'], 'src/cli.mjs');
    if (process.platform !== 'win32') {
      assert.notEqual(fs.statSync(path.join(root, 'src', 'cli.mjs')).mode & 0o111, 0);
    }
  });

  it('uses matching published workspace versions in package dependencies', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const name of ['js-deepresearch-engine', 'js-wiki-engine']) {
      const workspace = JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies[name], workspace.version);
      assert.equal(pkg.dependencies[name].startsWith('workspace:'), false);
    }
  });

  it('[V25] packaged sandbox CLI loads without development scripts or research storage', async t => {
    const root = path.resolve(import.meta.dirname, '..');
    const packaged = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-packaged-cli-'));
    t.after(() => fs.rmSync(packaged, { recursive: true, force: true }));
    fs.cpSync(path.join(root, 'src'), path.join(packaged, 'src'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(packaged, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(packaged, 'node_modules'), 'junction');
    const invoke = args => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(packaged, 'src/cli.mjs'), 'model-sandbox', ...args], {
        cwd: packaged, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME,
          NODE_OPTIONS: process.env.NODE_OPTIONS, JDR_VERIFY_ACTIVE: '1' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(fs.existsSync(path.join(packaged, 'scripts')), false);
    const help = await invoke(['help']); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--live/);
    const planned = await invoke(['plan', '--provider', 'openai-compatible', '--model', 'packaging-fixture',
      '--base-url', 'http://127.0.0.1:12345/v1', '--repeats', '1', '--json']);
    assert.equal(planned.code, 0, planned.stderr); assert.equal(JSON.parse(planned.stdout).cases.length, 3);
    assert.equal(fs.existsSync(path.join(packaged, 'data')), false);
    assert.equal(fs.existsSync(path.join(packaged, 'wiki')), false);
  });
});
