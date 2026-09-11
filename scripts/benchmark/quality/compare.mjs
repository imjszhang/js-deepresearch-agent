import fs from 'node:fs';
import path from 'node:path';
import { readJson, hash, invariant } from './schema.mjs';
import { loadLatestCheckpoint } from 'js-deepresearch-engine';
import { loadResult } from './load-result.mjs';
import { summarizeBudget } from './cost.mjs';
import { verifyArtifact, ARTIFACT_VERIFICATION_VERSION } from './artifact-verification.mjs';

function currentArtifactVerification(pin) {
  const record = { schemaVersion: ARTIFACT_VERIFICATION_VERSION, origin: 'program_check',
    scope: 'declared_artifact_integrity', resultPin: pin || null };
  if (!pin) return { ...record, status: 'incomplete', code: 'RESULT_PIN_UNAVAILABLE' };
  // Accounting can read a manifest without proving that every declared report
  // reference is valid. Neither that state nor a cached score grants this check.
  try { return verifyArtifact(pin); }
  catch { return { ...record, status: 'failed', code: 'ARTIFACT_INTEGRITY_INVALID' }; }
}

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
    if (score) invariant(hash(score.resultPin) === hash(run.pin), 'Score does not match campaign revision');
    return { id: run.id, caseId: run.case.id, queryHash: hash(run.case.query), inputPin: run.inputPin, pin: run.pin,
      repeat: run.repeat, status: run.status, score, accounting: runAccounting(run, score),
      artifactVerification: currentArtifactVerification(run.pin) };
  });
  return { id: campaign.id, mode: campaign.mode, protocolVersion: campaign.protocolVersion, plannedRuns: runs.length,
    deliveredRuns: runs.filter(r => r.status === 'research_complete').length,
    evaluatedRuns: runs.filter(r => r.score).length,
    modelCompletedRuns: runs.filter(r => modelComplete(r.score)).length,
    modelPendingRuns: runs.filter(r => modelObserved(r.score) && !modelComplete(r.score)).length,
    modelUnobservedRuns: runs.filter(r => !modelObserved(r.score)).length,
    artifactVerifiedRuns: runs.filter(r => r.artifactVerification.status === 'passed').length,
    artifactFailedRuns: runs.filter(r => r.artifactVerification.status === 'failed').length,
    artifactIncompleteRuns: runs.filter(r => r.artifactVerification.status === 'incomplete').length,
    deliverySuccessRate: runs.length ? runs.filter(r => r.status === 'research_complete').length / runs.length : null,
    runs };
}
export function compareCampaigns(a, b) {
  const warnings = [];
  if (a.protocolVersion !== b.protocolVersion || a.suiteHash !== b.suiteHash || hash(a.protocol) !== hash(b.protocol)) warnings.push('Different research protocols/cases');
  for (const k of ['settingsHash', 'skillHash', 'lockfileHash']) if (a.identity?.[k] !== b.identity?.[k]) warnings.push(`Different ${k}`);
  return { comparable: warnings.length === 0, warnings, baseline: a.id, candidate: b.id,
    statisticalClaim: 'Two repetitions are descriptive, not statistical significance or paired random trials.' };
}
function statistics(values) {
  const valid = values.filter(Number.isFinite);
  return { n: valid.length, planned: values.length, unavailable: values.length - valid.length,
    mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null };
}
const origin = score => score?.origin || score?.modelAssessment?.origin || 'model_assessment';
const modelObserved = score => Boolean(score && score.modelAssessment?.observed !== false);
const modelComplete = score => Boolean(modelObserved(score) && score.extractionComplete && score.metrics?.pendingReview === false);
export function modelObservationIdentity(score) {
  return hash([score.schemaVersion, score.goldHash, score.judgeVersion, score.judgeIdentity,
    score.scoringVersion, score.calibrationHash || null, origin(score)]);
}
export function pairSummaryRuns(baseline, candidate) {
  const index = summary => {
    const map = new Map();
    for (const run of summary.runs) {
      const key = JSON.stringify([run.caseId, run.repeat]);
      invariant(!map.has(key), 'Duplicate case/repeat in comparison');
      if (run.score) invariant(run.pin && hash(run.score.resultPin) === hash(run.pin), 'Score does not match campaign revision');
      map.set(key, run);
    }
    return map;
  };
  const a = index(baseline), b = index(candidate);
  return [...new Set([...a.keys(), ...b.keys()])].map(key => {
    const before = a.get(key), after = b.get(key);
    if (before && after) {
      invariant(before.queryHash === after.queryHash, 'Incompatible per-case query');
      if (candidate.mode === 'artifact_rebuild' || after.inputPin) invariant(hash(after.inputPin) === hash(before.pin), 'Rebuild input does not match baseline revision');
      if (before.score && after.score) {
        invariant(modelObservationIdentity(before.score) === modelObservationIdentity(after.score), 'Incompatible per-case evaluation versions or origin');
        invariant(hash(before.score.rows.map(r => r.id).sort()) === hash(after.score.rows.map(r => r.id).sort()), 'Criterion denominator changed');
      }
    }
    return { caseId: (before || after).caseId, repeat: (before || after).repeat, before, after,
      status: !modelObserved(before?.score) || !modelObserved(after?.score) ? 'unobserved' : modelComplete(before.score) && modelComplete(after.score) ? 'observed' : 'pending_review' };
  });
}
export function compareSummaries(baseline, candidate) {
  const pairs = pairSummaryRuns(baseline, candidate);
  const ids = [...new Set([...baseline.runs, ...candidate.runs].map(r => r.caseId))];
  return ids.map(caseId => {
    const before = baseline.runs.filter(r => r.caseId === caseId), after = candidate.runs.filter(r => r.caseId === caseId);
    const matched = pairs.filter(p => p.caseId === caseId);
    const measures = ['correctCoverage', 'evidenceCoverage', 'strictFactAccuracy', 'citationSupportRate', 'majorErrorCount'];
    const metrics = Object.fromEntries(measures.map(key => {
      const a = statistics(matched.map(p => p.status === 'observed' ? p.before.score.metrics[key] : null)),
        b = statistics(matched.map(p => p.status === 'observed' ? p.after.score.metrics[key] : null));
      return [key, { baseline: a, candidate: b, difference: a.mean == null || b.mean == null ? null : b.mean - a.mean }];
    }));
    const criterionIds = [...new Set([...before, ...after].flatMap(r => r.score?.rows.map(row => row.id) || []))];
    return { caseId, origin: [...new Set(matched.flatMap(p => [p.before?.score, p.after?.score].filter(Boolean).map(origin)))],
      pairs: matched.map(p => ({ repeat: p.repeat, status: p.status })), planned: { baseline: before.length, candidate: after.length },
      delivered: { baseline: before.filter(r => r.status === 'research_complete').length, candidate: after.filter(r => r.status === 'research_complete').length }, metrics,
      cost: { baseline: statistics(before.map(r => r.score?.cost?.confirmedTokens)), candidate: statistics(after.map(r => r.score?.cost?.confirmedTokens)),
        unknownUsage: [...before, ...after].some(r => r.score?.cost?.costIsLowerBound) },
      criteria: criterionIds.map(id => ({ id,
        baseline: before.map(r => ({ repeat: r.repeat, points: modelComplete(r.score) ? r.score.rows.find(row => row.id === id)?.points ?? null : null })),
        candidate: after.map(r => ({ repeat: r.repeat, points: modelComplete(r.score) ? r.score.rows.find(row => row.id === id)?.points ?? null : null })) })) };
  });
}
const pct = x => x == null ? 'N/A' : `${(100 * x).toFixed(1)}%`;
export function formatSummary(summary) {
  return [`# Research quality benchmark: ${summary.id}`, '',
    `Delivered ${summary.deliveredRuns}/${summary.plannedRuns}; artifact verified ${summary.artifactVerifiedRuns}/${summary.plannedRuns}; model complete ${summary.modelCompletedRuns}/${summary.plannedRuns}; model pending ${summary.modelPendingRuns}; unobserved ${summary.modelUnobservedRuns}.`, '',
    `Artifact failures ${summary.artifactFailedRuns ?? 'N/A'}; incomplete ${summary.artifactIncompleteRuns ?? 'N/A'}.`, '',
    '| Run | Research state | Artifact integrity | Coverage | Evidence coverage | Fact accuracy | Major errors | Floor | Confirmed tokens | Review |',
    '|---|---|---|---:|---:|---:|---:|---|---:|---|',
    ...summary.runs.map(r => `| ${r.id} | ${r.status} | ${r.artifactVerification?.status || 'not_checked'} | ${pct(r.score?.metrics.correctCoverage)} | ${pct(r.score?.metrics.evidenceCoverage)} | ${pct(r.score?.metrics.strictFactAccuracy)} | ${r.score?.metrics.majorErrorCount ?? 'N/A'} | ${r.accounting.cost?.floorStatus || 'unknown'} | ${r.accounting.cost?.confirmedTokens ?? 'N/A'} | ${r.score?.reviewStatus || 'not_evaluated'} |`), '',
    'Failures and unobserved runs remain in the planned denominator. Content scores are model observations, including historical scores; arithmetic does not prove semantic truth. Program verification and human review are separate.', ''].join('\n');
}
