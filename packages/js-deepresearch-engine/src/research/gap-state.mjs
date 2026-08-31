import { sourceHasBody } from './adaptive/exploratory-sufficiency.mjs';
import { classifySourceTier, evidenceIndependenceKey, hostnamesMatch, hostnameOf } from './adaptive/source-policy.mjs';

export const GAP_SCHEMA_VERSION = 2;
export const GAP_STATUSES = Object.freeze(['open', 'searched', 'body_read', 'verified', 'conflicting', 'limited']);

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function contradicts(source) {
  return source?.evidenceRole === 'contradicting'
    || source?.stance === 'contradicting'
    || source?.contradicts === true;
}

function satisfiesRequiredEvidence(source, gap) {
  if (!sourceHasBody(source)) return false;
  if ((gap.requiredHosts || []).length) {
    return gap.requiredHosts.some((host) => hostnamesMatch(hostnameOf(source.url || source.id), host));
  }
  if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
    return ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap));
  }
  return true;
}

export function normalizeGapRecord(gap = {}, defaults = {}) {
  return {
    ...gap,
    schemaVersion: GAP_SCHEMA_VERSION,
    id: gap.id || defaults.id || 'gap-1',
    question: String(gap.question || defaults.question || '').trim(),
    answerSlot: gap.answerSlot || defaults.answerSlot || null,
    claimFamily: gap.claimFamily || defaults.claimFamily || null,
    priority: gap.priority === 'critical' ? 'critical' : (defaults.priority || 'normal'),
    status: GAP_STATUSES.includes(gap.status) ? gap.status : 'open',
    supportingPassageIds: unique(gap.supportingPassageIds || gap.evidencePassageIds),
    contradictingPassageIds: unique(gap.contradictingPassageIds),
    confidence: Number.isFinite(gap.confidence) ? gap.confidence : null,
    missingEvidence: unique(gap.missingEvidence),
    nextQueries: unique(gap.nextQueries),
    resolutionReason: gap.resolutionReason || null,
  };
}

export function evaluateGapEvidence(gap, sources = [], { passageIds = [] } = {}) {
  const normalized = normalizeGapRecord(gap);
  const bodies = sources.filter(sourceHasBody);
  const supporting = bodies.filter((source) => !contradicts(source));
  const contradicting = bodies.filter(contradicts);
  const supportingPassageIds = unique([
    ...normalized.supportingPassageIds,
    ...passageIds,
    ...supporting.flatMap((source) => source.passageIds || []),
  ]);
  const contradictingPassageIds = unique([
    ...normalized.contradictingPassageIds,
    ...contradicting.flatMap((source) => source.passageIds || []),
  ]);
  const missingEvidence = [];
  const requiredSatisfied = !(normalized.requiredHosts || []).length
    && !(normalized.requiredSourceTypes || []).includes('primary_filing')
    ? true
    : supporting.some((source) => satisfiesRequiredEvidence(source, normalized));
  if (!bodies.length) missingEvidence.push('successful_body');
  if (!requiredSatisfied) missingEvidence.push(
    (normalized.requiredHosts || []).length ? 'required_host_body' : 'primary_filing',
  );
  const independent = new Set(supporting.map(evidenceIndependenceKey).filter(Boolean));
  const minIndependent = Math.max(1, Number(normalized.minIndependentSources) || 1);
  if (independent.size < minIndependent) missingEvidence.push('independent_sources');

  let status = normalized.status === 'searched' && !bodies.length ? 'searched' : 'open';
  let resolutionReason = null;
  if (contradicting.length) {
    status = 'conflicting';
    resolutionReason = 'Contradicting body evidence remains unresolved.';
  } else if (bodies.length && missingEvidence.length) {
    status = 'limited';
    resolutionReason = `Body evidence is incomplete: ${missingEvidence.join(', ')}.`;
  } else if (bodies.length) {
    status = 'verified';
    resolutionReason = 'Deterministic body, source-policy, and independence requirements passed.';
  }
  return {
    ...normalized,
    status,
    supportingPassageIds,
    contradictingPassageIds,
    missingEvidence,
    confidence: status === 'verified' ? 1 : null,
    resolutionReason,
  };
}

export function isMaterialGap(gap) {
  return gap?.priority === 'critical'
    || ['open', 'searched', 'conflicting', 'limited'].includes(gap?.status);
}
