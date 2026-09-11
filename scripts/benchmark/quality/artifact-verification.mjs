import fs from 'node:fs';
import path from 'node:path';
import { validateClaimGraph } from '../../../packages/js-deepresearch-engine/src/research/claim-graph.mjs';
import { loadResult, citedEvidence } from './load-result.mjs';
import { hash, invariant, readJson, writeJson } from './schema.mjs';

export const ARTIFACT_VERIFICATION_VERSION = 1;
function canonicalPath(file) {
  let existing = path.resolve(file);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    invariant(parent !== existing, 'OUTPUT_PATH_UNRESOLVED');
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}
const inside = (a, b) => a === b || a.startsWith(b + path.sep);
export function assertIsolatedOutput(directory, protectedPaths) {
  const output = canonicalPath(directory);
  for (const input of protectedPaths.filter(Boolean)) {
    const original = canonicalPath(input);
    invariant(!inside(output, original) && !inside(original, output), 'OUTPUT_OVERLAPS_INPUT');
  }
  return output;
}

// These checks prove declared references, never semantic support or completeness.
export function verifyArtifact(pin) {
  const artifact = loadResult(pin);
  const checks = { manifestAndBodies: true };
  const entries = Array.isArray(artifact.registry) ? artifact.registry : artifact.registry.entries;
  invariant(Array.isArray(entries), 'ARTIFACT_CITATION_REGISTRY_INVALID');
  const keys = new Set();
  for (const entry of entries) {
    const key = entry.citationKey || entry.key;
    invariant(typeof key === 'string' && /^\d+\.\d+$/.test(key) && !keys.has(key), 'ARTIFACT_CITATION_ID_INVALID');
    keys.add(key);
    const ids = entry.passageIds || (entry.passageId ? [entry.passageId] : []);
    invariant(ids.length > 0 && new Set(ids).size === ids.length, 'ARTIFACT_CITATION_PASSAGES_INVALID');
    for (const id of ids) {
      const passage = artifact.store.passages.get(id);
      invariant(passage && passage.documentVersionId === entry.documentVersionId && passage.sourceId === entry.sourceId,
        'ARTIFACT_CITATION_OWNER_INVALID');
      invariant(artifact.store.body(passage.documentVersionId).slice(passage.startChar, passage.endChar) === passage.text,
        'ARTIFACT_CITATION_RANGE_INVALID');
    }
  }
  invariant(citedEvidence(artifact).every(c => c.resolved), 'ARTIFACT_CITATION_UNRESOLVED');
  checks.declaredCitations = true;
  const plan = artifact.result.reportPlan;
  checks.declaredClaimBindings = null;
  if (plan?.claimRecords) {
    invariant(Array.isArray(plan.claimRecords) && Array.isArray(plan.bindings), 'ARTIFACT_BINDINGS_INVALID');
    const records = new Map(plan.claimRecords.map(r => [r.claimId, r]));
    invariant(records.size === plan.claimRecords.length, 'ARTIFACT_DUPLICATE_CLAIM');
    validateClaimGraph({ records: plan.claimRecords, bindings: plan.bindings }, artifact.store);
    for (const claim of records.values()) invariant((claim.citationKeys || []).every(key => keys.has(key)), 'ARTIFACT_CLAIM_CITATION_INVALID');
    for (const binding of plan.bindings) invariant(typeof binding.taskId === 'string'
      && (binding.claimId == null || records.has(binding.claimId)), 'ARTIFACT_BINDING_REFERENCE_INVALID');
    checks.declaredClaimBindings = true;
  }
  const budget = artifact.result.quality?.budget;
  checks.savedLedgerStructure = null;
  if (budget) {
    invariant(budget.usage && typeof budget.usage === 'object' && !Array.isArray(budget.usage), 'ARTIFACT_BUDGET_USAGE_INVALID');
    for (const value of Object.values(budget.usage || {})) invariant(Number.isFinite(value) && value >= 0, 'ARTIFACT_BUDGET_VALUE_INVALID');
    const reservations = budget.reservations || [], settled = budget.settledAttemptIds || [];
    invariant(Array.isArray(reservations) && Array.isArray(settled) && settled.every(id => typeof id === 'string' && id.length > 0), 'ARTIFACT_BUDGET_ATTEMPTS_INVALID');
    invariant(new Set(reservations.map(r => r?.attemptId)).size === reservations.length
      && new Set(settled).size === settled.length, 'ARTIFACT_BUDGET_DUPLICATE_ATTEMPT');
    for (const reservation of reservations) invariant(typeof reservation?.attemptId === 'string' && reservation.attemptId.length > 0
      && Number.isFinite(reservation.amount) && reservation.amount >= 0 && !settled.includes(reservation.attemptId), 'ARTIFACT_BUDGET_RESERVATION_INVALID');
    checks.savedLedgerStructure = true;
  }
  return { schemaVersion: ARTIFACT_VERIFICATION_VERSION, origin: 'program_check', status: 'passed',
    scope: 'declared_artifact_integrity', inputOrigin: artifact.result.benchmarkOrigin || null, resultPin: pin, reportHash: artifact.reportHash, checks,
    counts: { documentVersions: artifact.store.versions.size, passages: artifact.store.passages.size, citationEntries: entries.length },
    unavailable: { semanticTruth: true, extractionCompleteness: true, confirmedTokenReceiptSum: true } };
}

export function verifyCampaignArtifacts({ campaign, campaignFile, outputDir }) {
  invariant(Array.isArray(campaign?.runs), 'ARTIFACT_CAMPAIGN_INVALID');
  const directory = assertIsolatedOutput(outputDir, [campaignFile, ...campaign.runs.map(r => r.pin?.sessionDir)]);
  const inputIdentity = hash(campaign.runs.map(r => [r.id, r.status, r.pin || null]));
  const file = path.join(directory, 'artifact-verification.json');
  if (fs.existsSync(file)) invariant(readJson(file).inputIdentity === inputIdentity, 'ARTIFACT_VERIFICATION_INPUT_CHANGED');
  const runs = campaign.runs.map(run => {
    if (!run.pin) return { id: run.id, status: 'incomplete', code: 'RESULT_PIN_UNAVAILABLE' };
    try { return { id: run.id, ...verifyArtifact(run.pin) }; }
    catch { return { id: run.id, status: 'failed', code: 'ARTIFACT_INTEGRITY_INVALID' }; }
  });
  const status = runs.some(r => r.status === 'failed') ? 'failed' : runs.length && runs.every(r => r.status === 'passed') ? 'passed' : 'incomplete';
  const record = { schemaVersion: ARTIFACT_VERIFICATION_VERSION, origin: 'program_check', scope: 'declared_artifact_integrity',
    inputIdentity, status, plannedRuns: runs.length, checkedRuns: runs.filter(r => r.status === 'passed').length, runs };
  writeJson(file, record);
  return record;
}
