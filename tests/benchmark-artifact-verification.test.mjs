import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveResearchArtifacts } from 'js-deepresearch-engine';
import { verifyArtifact, verifyCampaignArtifacts, assertIsolatedOutput } from '../scripts/benchmark/quality/artifact-verification.mjs';
import { programTemp, programArtifact, programCampaign } from './helpers/program-artifacts.mjs';

test('[V16] artifact verification pins a complete revision and only certifies declared references', t => {
  const directory = programTemp(t), input = path.join(directory, 'input');
  const { pin, result } = programArtifact(input);
  saveResearchArtifacts({ sessionDir: input, query: 'fixture', strategy: 'focused', settings: {}, result: { ...result, resultRevision: 'later', report: '# Later report' } });
  fs.writeFileSync(path.join(input, 'report.md'), '# Stale root');
  const checked = verifyArtifact(pin);
  assert.equal(checked.status, 'passed'); assert.equal(checked.origin, 'program_check');
  assert.equal(checked.resultPin.resultRevision, 'baseline');
  assert.equal(checked.unavailable.semanticTruth, true); assert.equal(checked.unavailable.extractionCompleteness, true);
  assert.equal(checked.checks.declaredClaimBindings, null);
  assert.throws(() => verifyArtifact({ ...pin, resultRevision: 'later' }), /Pinned/);
  const manifest = JSON.parse(fs.readFileSync(path.join(input, pin.manifestPath), 'utf8'));
  fs.writeFileSync(path.join(input, pin.manifestPath), JSON.stringify({ ...manifest, changed: true }));
  assert.throws(() => verifyArtifact(pin));
});

test('[V16] valid file hashes cannot hide an unresolved citation or mismatched source owner', t => {
  const root = programTemp(t);
  const missing = programArtifact(path.join(root, 'missing'), 'missing', r => ({ ...r, report: '# Report\n\nUnresolved [99.1].' }));
  assert.throws(() => verifyArtifact(missing.pin), /CITATION_UNRESOLVED/);
  assert.throws(() => programArtifact(path.join(root, 'wrong'), 'wrong', r => {
    r.citationRegistry.entries[0].sourceId = 'another-owner'; return r;
  }), /Citation registry integrity/);
});

test('[V16] artifact checks retain missing runs and never overwrite inputs through aliases', t => {
  const root = programTemp(t), campaign = programCampaign(root);
  const file = path.join(root, 'campaign.json'); fs.writeFileSync(file, JSON.stringify(campaign));
  const before = fs.readFileSync(file);
  campaign.runs.push({ id: 'missing', status: 'research_failed' });
  const result = verifyCampaignArtifacts({ campaign, campaignFile: file, outputDir: path.join(root, 'checks') });
  assert.equal(result.status, 'incomplete'); assert.equal(result.plannedRuns, 5); assert.equal(result.checkedRuns, 4);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => verifyCampaignArtifacts({ campaign, campaignFile: file, outputDir: root }), /OVERLAPS/);
  const alias = path.join(root, 'alias'); fs.symlinkSync(campaign.runs[0].pin.sessionDir, alias, 'dir');
  assert.throws(() => assertIsolatedOutput(path.join(alias, 'child'), [campaign.runs[0].pin.sessionDir]), /OVERLAPS/);
});

test('[V16] artifact CLI executes offline without initializing application settings', t => {
  const root = programTemp(t), campaign = programCampaign(root), file = path.join(root, 'campaign.json');
  fs.writeFileSync(file, JSON.stringify(campaign));
  const probe = path.join(root, 'settings-probe.cjs');
  fs.writeFileSync(probe, `const fs = require('node:fs'); const original = fs.readFileSync; const exists = fs.existsSync;
    const forbidden = p => typeof p !== 'number' && /(?:^|\\/)\\.env$|js-deepresearch\\.sqlite/.test(String(p));
    fs.readFileSync = function(p,...args) { if (forbidden(p)) throw Error('SETTINGS_MUST_NOT_LOAD'); return original.call(this,p,...args); };
    fs.existsSync = function(p) { if(forbidden(p)) throw Error('SETTINGS_MUST_NOT_LOAD'); return exists.call(this,p); };
    require('node:module').syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--require', probe, 'scripts/benchmark-quality.mjs', 'verify-artifacts', '--campaign', file, '--output-dir', path.join(root, 'out')],
    { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', LLM_API_KEY: '' }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'passed');
});

test('[V16] malformed saved ledger types cannot become verified accounting', t => {
  const root = programTemp(t);
  for (const [i, settledAttemptIds] of ['abc', [1, 2], [''], ['repeat', 'repeat']].entries()) {
    const { pin } = programArtifact(path.join(root, 'ledger-' + i), 'ledger-' + i,
      r => ({ ...r, quality: { budget: { usage: {}, reservations: [], settledAttemptIds } } }));
    assert.throws(() => verifyArtifact(pin), /ARTIFACT_BUDGET/);
  }
});
