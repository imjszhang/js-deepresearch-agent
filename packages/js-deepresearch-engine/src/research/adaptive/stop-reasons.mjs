export const STOP_REASONS = Object.freeze({
  evidenceSufficient: 'evidence_sufficient',
  budgetExhausted: 'budget_exhausted',
  sourceBlocked: 'source_blocked',
  safetyCap: 'safety_cap',
  userCancelled: 'user_cancelled',
});

const CANONICAL = new Set(Object.values(STOP_REASONS));

const ALIASES = Object.freeze({
  max_budget_exhausted: STOP_REASONS.budgetExhausted,
  target_budget_reached: STOP_REASONS.budgetExhausted,
  max_steps_safety: STOP_REASONS.safetyCap,
  max_steps: STOP_REASONS.safetyCap,
  agent_stop: STOP_REASONS.safetyCap,
  fallback_exploration_exhausted: STOP_REASONS.budgetExhausted,
  forced_final_answer: STOP_REASONS.safetyCap,
});

const EVIDENCE_REASON_CODES = new Set([
  'evidence_sufficient',
  'fallback_evidence_sufficient',
  'agent_evidence_sufficient',
  'sufficient_evidence',
  'enough_evidence',
  'evidence_enough',
]);

export function normalizeStopReason(reason) {
  const code = String(reason || '').trim();
  if (!code) return null;
  if (CANONICAL.has(code)) return code;
  return ALIASES[code] || null;
}

export function isEvidenceSufficientReasonCode(code) {
  return EVIDENCE_REASON_CODES.has(String(code || '').trim());
}

export function mapControllerStopReason(action, pendingStopReason, gatePass = false) {
  if (pendingStopReason) return normalizeStopReason(pendingStopReason) || pendingStopReason;
  const code = String(action?.reasonCode || '').trim();
  const mapped = normalizeStopReason(code);
  if (mapped === STOP_REASONS.evidenceSufficient || isEvidenceSufficientReasonCode(code)) {
    return gatePass ? STOP_REASONS.evidenceSufficient : null;
  }
  if (mapped) return mapped;
  return null;
}

export function legacyStopReasonAlias(reason) {
  const canonical = normalizeStopReason(reason) || reason;
  if (canonical === STOP_REASONS.budgetExhausted) return 'max_budget_exhausted';
  if (canonical === STOP_REASONS.safetyCap) return 'max_steps_safety';
  return canonical;
}
