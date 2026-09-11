import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { programArtifact, programCampaign, programTemp } from './helpers/program-artifacts.mjs';

const entrypoints = ['scripts/benchmark-research.mjs', 'scripts/benchmark-strategies.mjs', 'scripts/benchmark/compare-extract-benchmark.mjs'];

function cliFixture(t) {
  const root = programTemp(t), probe = path.join(root, 'no-settings.cjs'), accessLog = path.join(root, 'forbidden-settings-access');
  fs.writeFileSync(probe, `const fs = require('node:fs');
    for (const method of ['readFileSync','existsSync']) { const original = fs[method];
      fs[method] = function(p,...args) {
        if (typeof p !== 'number' && /(?:^|\\/)\\.env$|js-deepresearch\\.sqlite/.test(String(p))) {
          fs.appendFileSync(${JSON.stringify(accessLog)}, 'blocked'); throw Error('SETTINGS_MUST_NOT_LOAD');
        }
        return original.call(this,p,...args);
      };
    }
    require('node:module').syncBuiltinESMExports();`);
  const invoke = (entry, args) => {
    const result = spawnSync(process.execPath, ['--require', probe, entry, ...args],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, OPENAI_API_KEY: '', LLM_API_KEY: '' } });
    assert.equal(fs.existsSync(accessLog), false, 'Offline command attempted to initialize application settings');
    return result;
  };
  return { root, invoke };
}

test('[V23] all former benchmark entrypoints share quality validation and artifact verification without settings', t => {
  const { root, invoke } = cliFixture(t), campaign = programCampaign(root), campaignFile = path.join(root, 'campaign.json');
  fs.writeFileSync(campaignFile, JSON.stringify(campaign));
  let suiteHash;
  for (const [i, entry] of entrypoints.entries()) {
    const validation = invoke(entry, ['--suite', 'benchmarks/research-quality/v1/suite.json', 'validate']);
    assert.equal(validation.status, 0, validation.stderr);
    const suite = JSON.parse(validation.stdout);
    assert.equal(suite.cases, 4);
    suiteHash ??= suite.suiteHash;
    assert.equal(suite.suiteHash, suiteHash);
    const verification = invoke(entry, ['verify-artifacts', '--campaign', campaignFile, '--output-dir', path.join(root, `verify-${i}`)]);
    assert.equal(verification.status, 0, verification.stderr);
    assert.deepEqual(JSON.parse(verification.stdout), { status: 'passed', plannedRuns: 4, checkedRuns: 4 });
  }
});

test('[V23] existing-result CLI uses versioned integrity and never reuses stored semantic verdicts', t => {
  const { root, invoke } = cliFixture(t), session = path.join(root, 'session');
  programArtifact(session, 'inspection', result => ({ ...result, claims: [{ id: 'fake', text: 'False but stored as supported',
    evaluation: { verdict: 'supported', method: 'llm' } }] }));
  const output = invoke(entrypoints[0], [session, '--json']);
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.artifactVerification.status, 'passed');
  assert.equal(result.modelAssessment.observed, false);
  assert.equal(result.modelAssessment.modelThresholdsMet, null);
  assert.equal(result.metrics.supportedRate, undefined);
  assert.equal(result.claims, undefined);
  const comparison = invoke(entrypoints[1], ['--sessions', `baseline=${session},candidate=${session}`, '--json']);
  assert.equal(comparison.status, 0, comparison.stderr);
  const compared = JSON.parse(comparison.stdout);
  assert.equal(compared.runs.length, 2);
  for (const row of compared.runs) {
    assert.equal(row.benchmark.artifactVerification.status, 'passed');
    assert.equal(row.benchmark.modelAssessment.observed, false);
  }
  const reportFile = path.join(session, 'report.md'), original = fs.readFileSync(reportFile);
  const overwrite = invoke(entrypoints[1], ['--sessions', `baseline=${session},candidate=${session}`, '--output', reportFile]);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /OUTPUT_OVERLAPS_INPUT/);
  assert.deepEqual(fs.readFileSync(reportFile), original);
});

test('[V23] model scoring and strategy dispatch cannot bypass explicit new execution inputs', t => {
  const { invoke } = cliFixture(t);
  const canonical = invoke('scripts/benchmark-quality.mjs', ['score', '--mode', 'model-observation']);
  for (const entry of entrypoints) {
    const score = invoke(entry, ['score', '--mode', 'model-observation']);
    assert.notEqual(score.status, 0);
    assert.equal(score.stderr, canonical.stderr);
    assert.doesNotMatch(score.stderr, /SETTINGS_MUST_NOT_LOAD/);
  }
  const implicit = invoke(entrypoints[0], ['unused-session', '--mode', 'model-observation']);
  assert.notEqual(implicit.status, 0);
  assert.match(implicit.stderr, /MODEL_OBSERVATION_REQUIRES_SCORE/);
  const strategy = invoke(entrypoints[1], ['--run', 'synthetic query']);
  assert.notEqual(strategy.status, 0);
  assert.match(strategy.stderr, /STRATEGY_RUN_REQUIRES_PROGRAM_VERIFICATION/);
  assert.doesNotMatch(strategy.stderr, /SETTINGS_MUST_NOT_LOAD/);
  for (const args of [['--run'], ['--run', 'query', '--sessions', 'one,two']]) {
    const invalid = invoke(entrypoints[1], args);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /query string|combined with/);
    assert.doesNotMatch(invalid.stderr, /SETTINGS_MUST_NOT_LOAD/);
  }
});
