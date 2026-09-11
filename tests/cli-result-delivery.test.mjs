import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileRunRecorder } from 'js-deepresearch-engine';
import Database from 'better-sqlite3';

test('CLI delivery failure returns valid JSON and nonzero exit; retry keeps one source and revision', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-cli-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'session');
  const recorder = new FileRunRecorder({ sessionDir, runId: 'run', strategy: 'quick', query: 'offline' });
  recorder.checkpoint('research-complete', { result: {
    resultRevision: 'final', report: '# Offline report', sources: [{ title: 'source', url: 'https://example.com/a' }],
    findings: [], gaps: [], claims: [], passages: [], quality: { gate: 'pass' },
  } });
  const repo = fileURLToPath(new URL('..', import.meta.url));
  // npm's local package form resolves jdr without depending on a globally installed binary.
  const invoke = (output) => spawnSync('npm', ['exec', `--package=${repo}`, '--', 'jdr',
    'research', '--resume', sessionDir, '--json', '--output', output,
  ], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, JDR_INTEL_STORE_DIR: path.join(root, 'intel'), npm_config_offline: 'true' },
  });
  const failed = invoke(path.join(root, 'missing', 'report.md'));
  assert.equal(failed.status, 1, failed.stderr);
  const first = JSON.parse(failed.stdout);
  assert.equal(first.report, '# Offline report');
  assert.equal(first.delivery.failures.find((x) => x.stage === 'output').code, 'ENOENT');
  const db = new Database(path.join(root, 'data/js-deepresearch.sqlite'));
  try {
    assert.equal(db.prepare('SELECT status FROM research_history').get().status, 'completed');
    const success = invoke(path.join(root, 'report.md'));
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).resultRevision, first.resultRevision);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
    assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8'), first.report);
  } finally { db.close(); }
});
