import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { JobRunner } from '../src/jobs/job-runner.mjs';

describe('JobRunner durable sessions', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a failed Web job session and exposes its path through history', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-job-recorder-'));
    tempDirs.push(workDir);
    const records = new Map([['job-1', {
      id: 'job-1',
      query: 'web failure',
      status: 'running',
      strategy: 'focused',
      sessionDir: null,
    }]]);
    const researchRepository = {
      updateStatus(id, status, fields = {}) {
        const next = { ...records.get(id), ...fields, status };
        records.set(id, next);
        return next;
      },
    };
    const jobRunner = new JobRunner({
      settingsStore: {},
      researchRepository,
      logRepository: { add(id, entry) { return { id, ...entry }; } },
      sourceRepository: { addMany() {} },
      eventBus: { emit() {} },
    });
    jobRunner.runner = {
      async run() {
        throw new Error('report transport failed');
      },
    };

    await jobRunner.runJob({
      id: 'job-1',
      query: 'web failure',
      settings: {
        research: { strategy: 'focused', workDir },
        llm: { apiKey: 'must-not-leak', maxTokens: 100 },
      },
      controller: new AbortController(),
    });

    const record = records.get('job-1');
    assert.equal(record.status, 'failed');
    assert.ok(record.sessionDir.startsWith(path.resolve(workDir)));
    const run = JSON.parse(fs.readFileSync(path.join(record.sessionDir, 'run.json'), 'utf8'));
    assert.equal(run.status, 'failed');
    assert.equal(run.settings.llm.apiKey, '[redacted]');
    assert.equal(fs.existsSync(path.join(record.sessionDir, 'failure.json')), true);
    assert.equal(fs.existsSync(path.join(record.sessionDir, 'report.md')), false);
  });
});
