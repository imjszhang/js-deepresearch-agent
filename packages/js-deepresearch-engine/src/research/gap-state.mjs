import { sourceHasBody } from './adaptive/exploratory-sufficiency.mjs';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  evidenceIndependenceKey,
  hostnamesMatch,
  hostnameOf,
} from './adaptive/source-policy.mjs';

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

function sourceIdentity(source) {
  return source?.id || source?.url || null;
}

function passagesForSource(source, passages = []) {
  const sourceId = sourceIdentity(source);
  const fromSource = unique(source?.passageIds);
  const fromRecords = passages
    .filter((passage) => passage?.id && (passage.sourceId === sourceId || fromSource.includes(passage.id)))
    .map((passage) => passage.id);
  return unique([...fromSource, ...fromRecords]);
}

function satisfiesRequiredEvidence(source, gap) {
  if (!sourceHasBody(source)) return false;
  if ((gap.requiredHosts || []).length) {
    return gap.requiredHosts.some((host) => hostnamesMatch(hostnameOf(source.url || source.id), host));
  }
  if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
    return ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap))
      && documentMatchesQuerySubject(source, gap.question);
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
    kind: gap.kind || defaults.kind || (gap.requiredSlot || defaults.requiredSlot ? 'slot' : 'followup'),
    rollup: Boolean(gap.rollup ?? defaults.rollup),
    requiredSlot: Boolean(gap.requiredSlot ?? defaults.requiredSlot),
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

export function evaluateGapEvidence(gap, sources = [], { passageIds = [], passages = [] } = {}) {
  const normalized = normalizeGapRecord(gap);
  const bodies = sources.filter(sourceHasBody);
  const supporting = bodies.filter((source) => !contradicts(source));
  const contradicting = bodies.filter(contradicts);
  const supportingPassageIds = unique([
    ...normalized.supportingPassageIds,
    ...supporting.flatMap((source) => passagesForSource(source, passages)),
    ...(contradicting.length ? [] : passageIds),
  ]);
  const contradictingPassageIds = unique([
    ...normalized.contradictingPassageIds,
    ...contradicting.flatMap((source) => passagesForSource(source, passages)),
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

export function isRequiredSlot(gap) {
  return Boolean(gap?.requiredSlot) && !gap?.rollup;
}

export function isMaterialGap(gap) {
  if (gap?.rollup) return false;
  return isRequiredSlot(gap)
    || gap?.priority === 'critical'
    || ['open', 'searched', 'conflicting', 'limited'].includes(gap?.status);
}

export function rollupRootGap(gaps = []) {
  const slots = gaps.filter((gap) => isRequiredSlot(gap));
  const root = gaps.find((gap) => gap.rollup || (gap.kind === 'root' && slots.length));
  if (!root || !slots.length) return gaps;
  if (slots.some((gap) => gap.status === 'conflicting')) {
    root.status = 'conflicting';
    root.resolutionReason = 'A required answer slot still has unresolved contradictory evidence.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || []));
  } else if (slots.every((gap) => gap.status === 'verified')) {
    root.status = 'verified';
    root.resolutionReason = 'All required answer slots were verified.';
    root.missingEvidence = [];
  } else if (slots.some((gap) => ['limited', 'body_read'].includes(gap.status))) {
    root.status = 'limited';
    root.resolutionReason = 'Required answer slots still have incomplete body evidence.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || []));
  } else if (slots.some((gap) => gap.status === 'searched')) {
    root.status = 'searched';
    root.resolutionReason = 'Required answer slots were searched but not yet verified.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  } else {
    root.status = 'open';
    root.resolutionReason = 'Required answer slots remain open.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  }
  return gaps;
}
