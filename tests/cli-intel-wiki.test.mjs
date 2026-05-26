import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'src', 'cli.mjs');

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('CLI intel and wiki commands', () => {
  const tempDirs = [];

  afterEach(() => {
    resetIntelStoreEngine();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedArchivedRun() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-cli-wiki-'));
    tempDirs.push(root);
    const intelDir = path.join(root, 'intel');
    const engine = createIntelStoreEngine({ baseDir: intelDir });

    archiveResearchResult({
      researchId: 'cli-wiki-run',
      query: 'llm wiki',
      strategy: 'source-based',
      result: {
        report: '# Report\n\n## Summary\n\n- LLM Wiki compiles sources into pages with references [1.1]\n',
        findings: [{ question: 'What is LLM Wiki?', iteration: 1, sources: [] }],
        sources: [
          {
            title: 'LLM Wiki Source',
            url: 'https://example.com/llm-wiki',
            snippet: 'LLM Wiki is a compiled knowledge base.',
            engine: 'test',
          },
        ],
      },
      artifacts: { sessionDir: path.join(root, 'session') },
      engine,
    });

    return { root, intelDir, vaultDir: path.join(root, 'wiki') };
  }

  it('lists archived runs from the main CLI', () => {
    const { root, intelDir } = seedArchivedRun();
    const result = runCli(['intel', 'list', '--intel-dir', intelDir, '--json'], { cwd: root });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload[0].researchId, 'cli-wiki-run');
    assert.equal(payload[0].sourcesCount, 1);
  });

  it('initializes, compiles, lints, and asks a wiki from the main CLI', () => {
    const { root, intelDir, vaultDir } = seedArchivedRun();
    const env = { JDR_INTEL_STORE_DIR: intelDir };

    const init = runCli(['wiki', 'init', '--vault', vaultDir, '--json'], { cwd: root, env });
    assert.equal(init.status, 0, init.stderr);
    assert.ok(fs.existsSync(path.join(vaultDir, 'Home.md')));

    const compile = runCli([
      'wiki',
      'compile',
      '--research-id',
      'cli-wiki-run',
      '--vault',
      vaultDir,
      '--lint',
      '--json',
    ], { cwd: root, env });
    assert.equal(compile.status, 0, compile.stderr);
    const compilePayload = JSON.parse(compile.stdout);
    assert.equal(compilePayload.researchId, 'cli-wiki-run');
    assert.equal(compilePayload.compiled, 1);
    assert.equal(compilePayload.lint.errorCount, 0);

    const lint = runCli(['wiki', 'lint', '--vault', vaultDir, '--json'], { cwd: root, env });
    assert.equal(lint.status, 0, lint.stderr);
    assert.equal(JSON.parse(lint.stdout).ok, true);

    const ask = runCli(['wiki', 'ask', 'LLM Wiki', '--vault', vaultDir, '--json'], { cwd: root, env });
    assert.equal(ask.status, 0, ask.stderr);
    const askPayload = JSON.parse(ask.stdout);
    assert.equal(askPayload.mode, 'retrieval');
    assert.ok(askPayload.pages.length > 0);
  });
});
