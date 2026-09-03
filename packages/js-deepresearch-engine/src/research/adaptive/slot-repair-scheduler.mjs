import { repairGapsFromGate } from './readiness-gate.mjs';

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function targetScore(gap) {
  let score = 0;
  if (gap.priority === 'critical') score += 100;
  if (gap.requiredSlot) score += 50;
  if ((gap.missingEvidence || []).some((item) => /required_host|required_source|primary_filing/.test(item))) score += 30;
  if (['body_read', 'limited', 'conflicting'].includes(gap.status)) score += 20;
  score -= Number(gap.repairFailures) || 0;
  return score;
}

export function rankSlotRepairTargets(gate = {}, gaps = []) {
  return repairGapsFromGate(gate || {}, gaps)
    .filter((gap) => gap.status !== 'blocked')
    .map((gap, index) => ({ gap, index, score: targetScore(gap) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.gap);
}

export function markRepairAngleExhausted(gap, queries = []) {
  if (!gap) return;
  gap.exhaustedAngles = unique([...(gap.exhaustedAngles || []), ...queries]);
  gap.repairAttempts = (Number(gap.repairAttempts) || 0) + 1;
}

export function nextSlotRepairAction(state, {
  readiness = state?.readiness,
  reasonCode = 'slot_repair_search',
} = {}) {
  const targets = rankSlotRepairTargets(readiness, state?.gaps || []);
  const blockedWithUnread = (state?.gaps || []).filter((gap) => (
    gap.status === 'blocked' && !gap.rollup && (state.pickPolicyReads?.(2, gap.id) || []).length
  ));
  for (const gap of [...targets, ...blockedWithUnread]) {
    const unread = state.pickPolicyReads?.(2, gap.id) || [];
    if (unread.length) {
      return {
        action: 'read',
        sourceIds: unread.map((candidate) => candidate.id),
        gapId: gap.id,
        reasonCode: 'slot_repair_read',
        repairTarget: gap.id,
      };
    }
    if (gap.status === 'blocked') continue;
    return {
      action: 'search',
      gapId: gap.id,
      plannerMode: 'repair',
      needsPlanner: true,
      reasonCode,
      repairTarget: gap.id,
    };
  }
  return null;
}
