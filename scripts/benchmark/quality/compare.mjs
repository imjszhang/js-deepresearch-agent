import fs from 'node:fs';
import path from 'node:path';
import { readJson, hash, invariant } from './schema.mjs';
import { loadLatestCheckpoint } from 'js-deepresearch-engine';
import { loadResult } from './load-result.mjs';
import { summarizeBudget } from './cost.mjs';

export function runAccounting(run, score) {
  let cost = score?.cost || null, health = 'not_available';
  if (!cost && run.pin) {
    try { cost = summarizeBudget(loadResult(run.pin).result.quality?.budget); health = 'manifest_verified'; }
    catch { health = 'artifact_invalid'; }
  } else if (cost) health = 'scored_revision';
  if (!cost && run.sessionDir && fs.existsSync(run.sessionDir)) {
    try { const checkpoint = loadLatestCheckpoint(run.sessionDir); cost = summarizeBudget(checkpoint?.state.budget); health = 'checkpoint_verified'; }
    catch { health = 'checkpoint_invalid'; }
  }
  const durations = (run.attempts || []).map(a => Date.parse(a.finishedAt) - Date.parse(a.startedAt));
  return { cost, health, attempts: run.attempts?.length || 0,
    completedAttemptWallMs: durations.length && durations.every(n => Number.isFinite(n) && n >= 0) ? durations.reduce((a, b) => a + b, 0) : null };
}

export function summarizeCampaign(campaign, directory, { evaluationDirectory = directory } = {}) {
  const runs = campaign.runs.map(run => {
    const file = path.join(evaluationDirectory, run.id, 'score.json');
    const score = fs.existsSync(file) ? readJson(file) : null;
    if (score) invariant(score.resultPin.resultRevision === run.pin?.resultRevision && score.resultPin.manifestHash === run.pin?.manifestHash, 'Score does not match campaign revision');
    return { id: run.id, caseId: run.case.id, queryHash: hash(run.case.query), inputPin: run.inputPin, pin: run.pin,
      repeat: run.repeat, status: run.status, score, accounting: runAccounting(run, score) };
  });
  return { id: campaign.id, protocolVersion: campaign.protocolVersion, plannedRuns: runs.length,
    deliveredRuns: runs.filter(r => r.status === 'research_complete').length,
    evaluatedRuns: runs.filter(r => r.score).length,
    deliverySuccessRate: runs.filter(r => r.status === 'research_complete').length / runs.length,
    runs };
}
export function compareCampaigns(a, b) {
  const warnings = [];
  if (a.protocolVersion !== b.protocolVersion || a.suiteHash !== b.suiteHash || hash(a.protocol) !== hash(b.protocol)) warnings.push('Different research protocols/cases');
  for (const k of ['settingsHash', 'skillHash', 'lockfileHash']) if (a.identity[k] !== b.identity[k]) warnings.push(`Different ${k}`);
  return { comparable: warnings.length === 0, warnings, baseline: a.id, candidate: b.id,
    statisticalClaim: 'Two repetitions are descriptive, not statistical significance or paired random trials.' };
}
function statistics(values) {
  const valid = values.filter(Number.isFinite);
  return { n: valid.length, mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null };
}
export function compareSummaries(baseline, candidate) {
  const versions = summary => [...new Set(summary.runs.filter(r => r.score).map(r => hash([r.score.goldHash,
    r.score.judgeVersion, r.score.judgeIdentity, r.score.scoringVersion, r.score.calibrationHash])))].sort();
  invariant(hash(versions(baseline)) === hash(versions(candidate)), 'Incompatible evaluation versions; rescore both inputs');
  const ids = [...new Set([...baseline.runs, ...candidate.runs].map(r => r.caseId))];
  return ids.map(caseId => {
    const before = baseline.runs.filter(r => r.caseId === caseId), after = candidate.runs.filter(r => r.caseId === caseId);
    const measures = ['correctCoverage', 'evidenceCoverage', 'strictFactAccuracy', 'citationSupportRate', 'majorErrorCount'];
    const metrics = Object.fromEntries(measures.map(key => {
      const a = statistics(before.map(r => r.score?.metrics[key])), b = statistics(after.map(r => r.score?.metrics[key]));
      return [key, { baseline: a, candidate: b, difference: a.mean == null || b.mean == null ? null : b.mean - a.mean }];
    }));
    const criterionIds = [...new Set([...before, ...after].flatMap(r => r.score?.rows.map(row => row.id) || []))];
    return { caseId, planned: { baseline: before.length, candidate: after.length },
      delivered: { baseline: before.filter(r => r.status === 'research_complete').length, candidate: after.filter(r => r.status === 'research_complete').length }, metrics,
      cost: { baseline: statistics(before.map(r => r.score?.cost?.confirmedTokens)), candidate: statistics(after.map(r => r.score?.cost?.confirmedTokens)),
        unknownUsage: [...before, ...after].some(r => r.score?.cost?.costIsLowerBound) },
      criteria: criterionIds.map(id => ({ id,
        baseline: before.map(r => ({ repeat: r.repeat, points: r.score?.rows.find(row => row.id === id)?.points ?? null })),
        candidate: after.map(r => ({ repeat: r.repeat, points: r.score?.rows.find(row => row.id === id)?.points ?? null })) })) };
  });
}
const pct = x => x == null ? 'N/A' : `${(100 * x).toFixed(1)}%`;
export function formatSummary(summary) {
  return [`# Research quality benchmark: ${summary.id}`, '',
    `Delivered ${summary.deliveredRuns}/${summary.plannedRuns}; evaluated ${summary.evaluatedRuns}/${summary.plannedRuns}.`, '',
    '| Run | Research state | Coverage | Evidence coverage | Fact accuracy | Major errors | Floor | Confirmed tokens | Review |',
    '|---|---|---:|---:|---:|---:|---|---:|---|',
    ...summary.runs.map(r => `| ${r.id} | ${r.status} | ${pct(r.score?.metrics.correctCoverage)} | ${pct(r.score?.metrics.evidenceCoverage)} | ${pct(r.score?.metrics.strictFactAccuracy)} | ${r.score?.metrics.majorErrorCount ?? 'N/A'} | ${r.accounting.cost?.floorStatus || 'unknown'} | ${r.accounting.cost?.confirmedTokens ?? 'N/A'} | ${r.score?.reviewStatus || 'not_evaluated'} |`), '',
    'Failures remain in the delivery denominator. Content scores only describe delivered reports. Machine judgments require the stated review; no human review is implied.', ''].join('\n');
}
