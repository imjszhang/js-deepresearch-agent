import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveResearchArtifacts } from 'js-deepresearch-engine';
import { summarizeCampaign, formatSummary } from '../scripts/benchmark/quality/compare.mjs';
import { verifyArtifact, verifyCampaignArtifacts } from '../scripts/benchmark/quality/artifact-verification.mjs';
import { loadResult } from '../scripts/benchmark/quality/load-result.mjs';
import { programTemp, programArtifact } from './helpers/program-artifacts.mjs';

function run(id, pin) {
  return { id, case: { id, query: 'synthetic query' }, repeat: 1, status: pin ? 'research_complete' : 'research_failed', pin };
}
function broken(root) {
  return programArtifact(path.join(root, 'broken'), 'broken', r => ({ ...r,
    report: '# Synthetic report\n\nA declared reference has no registry entry [99.1].',
    quality: { budget: { usage: { llmTokens: 42 }, reservations: [], settledAttemptIds: [] } } }));
}

test('[V19] summary requires full artifact integrity even when hashes and accounting are valid', t => {
  const root = programTemp(t), good = programArtifact(path.join(root, 'good')), bad = broken(root);
  assert.equal(loadResult(bad.pin).result.quality.budget.usage.llmTokens, 42);
  assert.throws(() => verifyArtifact(bad.pin), /ARTIFACT_CITATION_UNRESOLVED/);
  const campaign = { id: 'summary-fixture', runs: [run('good', good.pin), run('bad', bad.pin), run('missing', null)] };
  const file = path.join(root, 'campaign.json'); fs.writeFileSync(file, JSON.stringify(campaign));
  const independent = verifyCampaignArtifacts({ campaign, campaignFile: file, outputDir: path.join(root, 'verified') });
  const summary = summarizeCampaign(campaign, path.join(root, 'scores'));
  assert.equal(summary.plannedRuns, 3); assert.equal(summary.deliveredRuns, 2);
  assert.equal(summary.modelUnobservedRuns, 3); assert.equal(summary.modelCompletedRuns, 0);
  assert.equal(summary.artifactVerifiedRuns, 1); assert.equal(summary.artifactFailedRuns, 1); assert.equal(summary.artifactIncompleteRuns, 1);
  assert.deepEqual(summary.runs.map(r => r.artifactVerification.status), independent.runs.map(r => r.status));
  assert.equal(summary.runs[1].accounting.health, 'manifest_verified');
  assert.equal(summary.runs[1].accounting.cost.confirmedTokens, 42);
  assert.equal(summary.runs[1].artifactVerification.code, 'ARTIFACT_INTEGRITY_INVALID');
  assert.match(formatSummary(summary), /Artifact failures 1; incomplete 1/);
  assert.match(formatSummary(summary), /\| bad \| research_complete \| failed \|/);
});

test('[V19] cached passing scores cannot grant current artifact verification', t => {
  const root = programTemp(t), input = programArtifact(path.join(root, 'input'));
  const campaign = { id: 'cached', runs: [run('one', input.pin)] };
  const scoreDir = path.join(root, 'scores'), scoreFile = path.join(scoreDir, 'one', 'score.json');
  fs.mkdirSync(path.dirname(scoreFile), { recursive: true });
  fs.writeFileSync(scoreFile, JSON.stringify({ resultPin: input.pin, artifactVerification: { status: 'passed' },
    modelAssessment: { observed: false }, extractionComplete: false, metrics: { pendingReview: true },
    cost: { confirmedTokens: 42 } }));
  const saved = fs.readFileSync(scoreFile);
  assert.equal(summarizeCampaign(campaign, scoreDir).artifactVerifiedRuns, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(input.pin.sessionDir, input.pin.manifestPath)));
  const body = Object.keys(manifest.files).find(file => file.startsWith('evidence-bodies/'));
  fs.appendFileSync(path.join(input.pin.sessionDir, path.dirname(input.pin.manifestPath), body), '\nChanged body');
  const failed = summarizeCampaign(campaign, scoreDir);
  assert.equal(failed.artifactVerifiedRuns, 0); assert.equal(failed.artifactFailedRuns, 1);
  assert.equal(failed.runs[0].accounting.health, 'scored_revision');
  assert.equal(failed.runs[0].accounting.cost.confirmedTokens, 42);
  assert.deepEqual(fs.readFileSync(scoreFile), saved);

  const bad = broken(root);
  campaign.runs[0].pin = bad.pin;
  fs.writeFileSync(scoreFile, JSON.stringify({ ...JSON.parse(saved), resultPin: bad.pin }));
  assert.equal(summarizeCampaign(campaign, scoreDir).artifactVerifiedRuns, 0);
  assert.equal(loadResult(bad.pin).result.quality.budget.usage.llmTokens, 42);
});

test('[V19] summary keeps the pinned revision and never infers verification from a session alone', t => {
  const root = programTemp(t), input = programArtifact(path.join(root, 'input'));
  saveResearchArtifacts({ sessionDir: input.pin.sessionDir, query: 'later', strategy: 'focused', settings: {},
    result: { ...input.result, resultRevision: 'later', report: '# Later\n\nUnresolved [99.1].' } });
  const campaign = { id: 'pinned', runs: [run('pinned', input.pin), { ...run('missing', null), sessionDir: input.pin.sessionDir }] };
  const summary = summarizeCampaign(campaign, path.join(root, 'scores'));
  assert.equal(summary.artifactVerifiedRuns, 1); assert.equal(summary.artifactIncompleteRuns, 1);
  assert.deepEqual(summary.runs[0].artifactVerification.resultPin, input.pin);
  assert.equal(summary.runs[1].artifactVerification.code, 'RESULT_PIN_UNAVAILABLE');
  assert.equal(summary.runs[1].artifactVerification.resultPin, null);
});

test('[V19] every summary CLI agrees with full verification on a hash-valid broken reference', t => {
  const root = programTemp(t), bad = broken(root), file = path.join(root, 'campaign.json');
  const campaign = { id: 'cli-summary', runs: [run('bad', bad.pin), run('missing', null)] };
  fs.writeFileSync(file, JSON.stringify(campaign));
  for (const entry of ['scripts/benchmark-quality.mjs', 'scripts/benchmark-research.mjs',
    'scripts/benchmark-strategies.mjs', 'scripts/benchmark/compare-extract-benchmark.mjs']) {
    const result = spawnSync(process.execPath, [entry, 'summary', '--campaign', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Delivered 1\/2; artifact verified 0\/2; model complete 0\/2; model pending 0; unobserved 2/);
    assert.match(result.stdout, /Artifact failures 1; incomplete 1/);
    assert.match(result.stdout, /\| bad \| research_complete \| failed \|/);
  }
});
