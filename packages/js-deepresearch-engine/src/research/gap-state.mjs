import { sourceHasBody } from './adaptive/exploratory-sufficiency.mjs';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  evidenceIndependenceKey,
  requiredHostCoverage,
} from './adaptive/source-policy.mjs';

export const GAP_SCHEMA_VERSION = 4;
export const GAP_STATUSES = Object.freeze(['open', 'searched', 'body_read', 'verified', 'conflicting', 'limited', 'blocked']);

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
  if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
    return ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap))
      && documentMatchesQuerySubject(source, gap.question);
  }
  return true;
}

export function isRequiredSlot(gap) {
  return Boolean(gap?.requiredSlot) && !gap?.rollup;
}

export function needsSemanticClose(gap) {
  if (gap?.rollup) return false;
  return Boolean(gap?.requiredSlot) || gap?.kind === 'root';
}

export function collectGapSources(gap, findings = []) {
  const dedicatedFindings = findings.filter((finding) => (
    finding.gapId === gap.id
    || (gap.contractSlotId && finding.contractSlotId === gap.contractSlotId)
    || (!finding.gapId && !finding.contractSlotId && gap.answerSlot && finding.answerSlot === gap.answerSlot)
  ));
  const dedicated = dedicatedFindings.flatMap((finding) => (finding.sources || []).filter(sourceHasBody));
  return dedicated;
}

export function normalizeGapRecord(gap = {}, defaults = {}) {
  return {
    ...gap,
    schemaVersion: GAP_SCHEMA_VERSION,
    id: gap.id || defaults.id || 'gap-1',
    question: String(gap.question || defaults.question || '').trim(),
    contractSlotId: gap.contractSlotId || defaults.contractSlotId || null,
    answerSlot: gap.answerSlot || defaults.answerSlot || null,
    claimFamily: gap.claimFamily || defaults.claimFamily || null,
    kind: gap.kind || defaults.kind || (gap.requiredSlot || defaults.requiredSlot ? 'slot' : 'followup'),
    rollup: Boolean(gap.rollup ?? defaults.rollup),
    requiredSlot: Boolean(gap.requiredSlot ?? defaults.requiredSlot),
    requiredHostMode: gap.requiredHostMode === 'all' ? 'all' : 'any',
    preferredHosts: unique(gap.preferredHosts || defaults.preferredHosts),
    priority: gap.priority === 'critical' ? 'critical' : (defaults.priority || 'normal'),
    status: GAP_STATUSES.includes(gap.status) ? gap.status : 'open',
    supportingPassageIds: unique(gap.supportingPassageIds || gap.evidencePassageIds),
    contradictingPassageIds: unique(gap.contradictingPassageIds),
    confidence: Number.isFinite(gap.confidence) ? gap.confidence : null,
    evidenceCriteria: unique(gap.evidenceCriteria || defaults.evidenceCriteria),
    slotSupport: gap.slotSupport || defaults.slotSupport || null,
    missingEvidence: unique(gap.missingEvidence),
    nextQueries: unique(gap.nextQueries),
    resolutionReason: gap.resolutionReason || null,
    blockedReason: gap.blockedReason || null,
    repairFailures: Math.max(0, Number(gap.repairFailures) || 0),
    repairAttempts: Math.max(0, Number(gap.repairAttempts) || 0),
    exhaustedAngles: unique(gap.exhaustedAngles),
  };
}

export function evaluateGapProvenance(gap, sources = [], { passageIds = [], passages = [] } = {}) {
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
  const hostCoverage = requiredHostCoverage(supporting, normalized);
  const primarySatisfied = !(normalized.requiredSourceTypes || []).includes('primary_filing')
    || supporting.some((source) => satisfiesRequiredEvidence(source, normalized));
  const requiredSatisfied = hostCoverage.satisfied && primarySatisfied;
  if (!bodies.length) missingEvidence.push('successful_body');
  if (!hostCoverage.satisfied) missingEvidence.push('required_host_body');
  if (!primarySatisfied) missingEvidence.push('primary_filing');
  const independent = new Set(supporting.map(evidenceIndependenceKey).filter(Boolean));
  const minIndependent = Math.max(1, Number(normalized.minIndependentSources) || 1);
  if (independent.size < minIndependent) missingEvidence.push('independent_sources');
  return {
    ...normalized,
    bodies,
    supporting,
    contradicting,
    supportingPassageIds,
    contradictingPassageIds,
    missingEvidence,
    requiredSatisfied,
  };
}

export function synthesizeGapStatus(gap, provenance = {}, slotSupport = null) {
  const support = slotSupport || provenance.slotSupport || gap.slotSupport || null;
  const missingEvidence = unique(provenance.missingEvidence);
  const base = {
    ...normalizeGapRecord(gap),
    supportingPassageIds: unique([
      ...(provenance.supportingPassageIds || []),
      ...(support?.supportingPassageIds || []),
    ]),
    contradictingPassageIds: unique([
      ...(provenance.contradictingPassageIds || []),
      ...(support?.contradictingPassageIds || []),
    ]),
    slotSupport: support,
    missingEvidence,
    confidence: null,
    resolutionReason: null,
  };
  if (gap.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      blockedReason: gap.blockedReason || 'repair_exhausted',
      resolutionReason: gap.resolutionReason || 'Evidence repair was exhausted.',
    };
  }

  const searched = base.status === 'searched' || (gap.searchedQueries || []).length > 0;
  if (!(provenance.bodies || []).length) {
    return {
      ...base,
      status: searched ? 'searched' : 'open',
      resolutionReason: null,
    };
  }
  if ((provenance.contradicting || []).length || support?.verdict === 'conflicting') {
    return {
      ...base,
      status: 'conflicting',
      resolutionReason: 'Contradicting body evidence remains unresolved.',
    };
  }
  if (missingEvidence.length) {
    return {
      ...base,
      status: 'limited',
      resolutionReason: `Body evidence is incomplete: ${missingEvidence.join(', ')}.`,
    };
  }
  if (needsSemanticClose(gap) || isRequiredSlot(gap)) {
    const anchored = Boolean(support?.quoteAnchored && support?.method === 'llm');
    if (support?.verdict === 'supported' && anchored) {
      return {
        ...base,
        status: 'verified',
        missingEvidence: [],
        confidence: 1,
        resolutionReason: 'Required slot is quote-anchored supported and provenance passed.',
      };
    }
    if (support?.verdict === 'partially_supported' && anchored) {
      return {
        ...base,
        status: 'body_read',
        missingEvidence: unique([...missingEvidence, 'slot_partial']),
        resolutionReason: 'Body evidence only partially supports the required slot.',
      };
    }
    return {
      ...base,
      status: 'body_read',
      missingEvidence: unique([...missingEvidence, 'slot_support']),
      resolutionReason: 'Body was read but the slot is not quote-anchored supported.',
    };
  }
  return {
    ...base,
    status: 'verified',
    missingEvidence: [],
    confidence: 1,
    resolutionReason: 'Deterministic body, source-policy, and independence requirements passed.',
  };
}

export function evaluateGapEvidence(gap, sources = [], {
  passageIds = [],
  passages = [],
  slotSupport,
} = {}) {
  const provenance = evaluateGapProvenance(gap, sources, { passageIds, passages });
  return synthesizeGapStatus(gap, provenance, slotSupport ?? gap.slotSupport);
}

export function isMaterialGap(gap) {
  if (gap?.rollup) return false;
  return isRequiredSlot(gap)
    || gap?.priority === 'critical'
    || ['open', 'searched', 'conflicting', 'limited', 'body_read'].includes(gap?.status);
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
  } else if (slots.some((gap) => gap.status === 'blocked')) {
    root.status = 'blocked';
    root.resolutionReason = 'One or more required answer slots exhausted evidence repair.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  } else {
    root.status = 'open';
    root.resolutionReason = 'Required answer slots remain open.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  }
  return gaps;
}
