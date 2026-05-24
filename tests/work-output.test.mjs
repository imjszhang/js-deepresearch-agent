import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createWorkSessionDir,
  formatSessionTimestamp,
  resolveWorkDir,
  saveResearchToWorkDir,
} from '../src/research/work-output.mjs';

describe('work output', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-work-output-'));
    tempDirs.push(dir);
    return dir;
  }

  it('formats session timestamps for directory names', () => {
    const timestamp = formatSessionTimestamp(new Date('2026-05-25T17:38:28.455Z'));
    assert.equal(timestamp, '2026-05-25_173828');
  });

  it('resolves the configured work directory', () => {
    const cwd = makeTempRoot();
    const absolute = resolveWorkDir({ research: { workDir: '/tmp/custom-work' } }, cwd);
    const relative = resolveWorkDir({ research: { workDir: 'custom-work' } }, cwd);

    assert.equal(absolute, path.resolve('/tmp/custom-work'));
    assert.equal(relative, path.join(cwd, 'custom-work'));
  });

  it('creates strategy and timestamp subdirectories', () => {
    const cwd = makeTempRoot();
    const settings = { research: { workDir: 'work_dir' } };
    const date = new Date('2026-05-25T17:38:28.455Z');
    const sessionDir = createWorkSessionDir({
      settings,
      strategy: 'rapid',
      cwd,
      date,
    });

    assert.equal(sessionDir, path.join(cwd, 'work_dir', 'rapid', '2026-05-25_173828'));
    assert.equal(fs.existsSync(sessionDir), true);
  });

  it('writes report and search artifacts into the session directory', () => {
    const cwd = makeTempRoot();
    const settings = { research: { workDir: 'work_dir', iterations: 1, questionsPerIteration: 2 } };
    const date = new Date('2026-05-25T17:38:28.455Z');
    const result = {
      report: '# Report\n\nExample.',
      findings: [{ question: 'What is TypeScript?', sources: [{ title: 'Example', url: 'https://example.com' }] }],
      sources: [{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }],
    };

    const artifacts = saveResearchToWorkDir({
      settings,
      strategy: 'source-based',
      query: 'What is TypeScript?',
      result,
      researchId: 'research-123',
      cwd,
      date,
    });

    assert.equal(
      artifacts.sessionDir,
      path.join(cwd, 'work_dir', 'source-based', '2026-05-25_173828'),
    );
    assert.equal(fs.readFileSync(artifacts.reportPath, 'utf8'), result.report);
    assert.deepEqual(JSON.parse(fs.readFileSync(artifacts.findingsPath, 'utf8')), result.findings);
    assert.deepEqual(JSON.parse(fs.readFileSync(artifacts.sourcesPath, 'utf8')), result.sources);

    const meta = JSON.parse(fs.readFileSync(artifacts.metaPath, 'utf8'));
    assert.equal(meta.query, 'What is TypeScript?');
    assert.equal(meta.strategy, 'source-based');
    assert.equal(meta.researchId, 'research-123');
    assert.equal(meta.settings.iterations, 1);
    assert.equal(meta.settings.questionsPerIteration, 2);
  });
});
