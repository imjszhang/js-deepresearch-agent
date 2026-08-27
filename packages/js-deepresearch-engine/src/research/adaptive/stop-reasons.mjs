export const EXPLORATORY_STOP_REASONS = Object.freeze({
  evidenceSufficient: 'evidence_sufficient',
  budgetExhausted: 'budget_exhausted',
  sourceBlocked: 'source_blocked',
  safetyCap: 'safety_cap',
  userCancelled: 'user_cancelled',
});

const LEGACY_TO_CANONICAL = Object.freeze({
  max_budget_exhausted: EXPLORATORY_STOP_REASONS.budgetExhausted,
  target_budget_reached: EXPLORATORY_STOP_REASONS.budgetExhausted,
  max_steps_safety: EXPLORATORY_STOP_REASONS.safetyCap,
  max_steps: EXPLORATORY_STOP_REASONS.safetyCap,
  agent_stop: EXPLORATORY_STOP_REASONS.sourceBlocked,
  fallback_exploration_exhausted: EXPLORATORY_STOP_REASONS.sourceBlocked,
});

const EVIDENCE_SUFFICIENT_CODES = new Set([
  'evidence_sufficient',
  'fallback_evidence_sufficient',
  'agent_evidence_sufficient',
  'sufficient_evidence',
  'enough_evidence',
  'evidence_enough',
]);

export function normalizeExploratoryStopReason(reason) {
  const code = String(reason || '').trim();
  if (!code) return null;
  if (Object.values(EXPLORATORY_STOP_REASONS).includes(code)) return code;
  if (LEGACY_TO_CANONICAL[code]) return LEGACY_TO_CANONICAL[code];
  if (EVIDENCE_SUFFICIENT_CODES.has(code)) return EXPLORATORY_STOP_REASONS.evidenceSufficient;
  return null;
}

export function isEvidenceSufficientReasonCode(reason) {
  return EVIDENCE_SUFFICIENT_CODES.has(String(reason || '').trim());
}

export function mapFinalizeStopReason(action, pendingStopReason, gatePassed = false) {
  const pending = normalizeExploratoryStopReason(pendingStopReason);
  if (pending && pending !== EXPLORATORY_STOP_REASONS.evidenceSufficient) return pending;
  if (gatePassed && (pending === EXPLORATORY_STOP_REASONS.evidenceSufficient || isEvidenceSufficientReasonCode(action?.reasonCode))) {
    return EXPLORATORY_STOP_REASONS.evidenceSufficient;
  }
  if (gatePassed && ['finalize', 'answer', 'stop'].includes(action?.action)) {
    return EXPLORATORY_STOP_REASONS.evidenceSufficient;
  }
  if (pending) return pending;
  const mapped = normalizeExploratoryStopReason(action?.reasonCode);
  if (mapped === EXPLORATORY_STOP_REASONS.evidenceSufficient && !gatePassed) {
    return null;
  }
  return mapped;
}
