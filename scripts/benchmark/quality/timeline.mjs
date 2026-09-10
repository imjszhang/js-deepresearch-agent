import fs from 'node:fs';
import { readEventJournal } from 'js-deepresearch-engine';
import { hash, invariant, readJson, within } from './schema.mjs';
import { summarizeBudget } from './cost.mjs';

// Read checkpoint metadata only. Body/summary blobs are deliberately not loaded;
// the pinned evidence manifest separately verifies the final source bodies.
export function evidenceTimeline(sessionDir, resultRevision = null) {
  const events = readEventJournal(sessionDir);
  const candidates = new Map(), versions = new Map(), passages = new Map(), claims = new Map(), bindings = new Map();
  const points = [];
  let matchedRevision = false;
  const first = (map, id, value) => { if (typeof id === 'string' && id && !map.has(id)) map.set(id, value); };
  for (const event of events.filter(e => e.type === 'checkpoint_committed')) {
    const checkpoint = readJson(within(sessionDir, event.checkpointPath));
    invariant(checkpoint.checkpointId === event.checkpointId && checkpoint.state?.sha256 === event.state?.sha256, 'Timeline checkpoint differs from journal');
    const bytes = fs.readFileSync(within(sessionDir, checkpoint.state.path));
    invariant(hash(bytes) === checkpoint.state.sha256, 'Timeline checkpoint hash mismatch');
    const state = JSON.parse(bytes);
    const budget = summarizeBudget(state.budget || state.result?.quality?.budget);
    const point = { checkpointId: checkpoint.checkpointId, boundary: checkpoint.boundary, createdAt: checkpoint.createdAt,
      confirmedTokens: budget.confirmedTokens, explorationTokens: budget.explorationTokens ?? null, usageUnknown: !budget.available || budget.costIsLowerBound };
    const store = state.evidenceStore || {};
    for (const pair of state.candidates || []) {
      const candidate = Array.isArray(pair) ? pair[1] : pair;
      first(candidates, candidate?.url, { ...point, sourceId: candidate?.id || null });
    }
    for (const version of store.versions || []) first(versions, version.documentVersionId, { ...point, url: version.url, sourceId: version.sourceId });
    for (const passage of store.passages || []) first(passages, passage.id, { ...point, documentVersionId: passage.documentVersionId });
    const plan = state.result?.reportPlan || state;
    for (const claim of plan.claimRecords || []) first(claims, claim.claimId, point);
    for (const binding of plan.bindings || []) if (binding.claimId) first(bindings, `${binding.taskId}:${binding.claimId}`, point);
    if (store.versions || plan.claimRecords || checkpoint.boundary === 'research-complete') points.push({ ...point,
      discoveredUrls: candidates.size, bodyVersions: versions.size, passages: passages.size, claims: claims.size, bindings: bindings.size });
    if (resultRevision && state.result?.resultRevision === resultRevision) { matchedRevision = true; break; }
  }
  invariant(!resultRevision || matchedRevision, 'Pinned result checkpoint unavailable for timeline');
  return { schemaVersion: 1, points, firstCandidate: Object.fromEntries(candidates), firstBody: Object.fromEntries(versions),
    firstPassage: Object.fromEntries(passages), firstClaimRecord: Object.fromEntries(claims), firstBinding: Object.fromEntries(bindings),
    limitations: ['Times are first observed checkpoint boundaries, not exact action times.',
      'A stored claim or binding is not an independently correct judgment.',
      'This is evidence acquisition telemetry, not intermediate report quality.'] };
}

export function diagnosisTiming(diagnosis, timeline) {
  const observedBodies = diagnosis.contexts.map(c => ({ documentVersionId: c.documentVersionId,
    firstCandidate: timeline.firstCandidate[c.url] || null, firstBody: timeline.firstBody[c.documentVersionId] || null }));
  return { observedBodies, firstClaimRecords: diagnosis.claimIds.map(id => ({ claimId: id, point: timeline.firstClaimRecord[id] || null })),
    firstIndependentCorrectJudgment: null,
    limitation: 'Historical claims were not independently re-judged; correctness time is unmeasured.' };
}
