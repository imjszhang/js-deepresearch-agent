import { sourceHasBody } from './adaptive/exploratory-sufficiency.mjs';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  evidenceIndependenceKey,
  requiredHostCoverage,
} from './adaptive/source-policy.mjs';
import {
  evaluateEvidenceCriteria,
  missingEvidenceForCriteria,
} from './evidence-criteria.mjs';

export const GAP_SCHEMA_VERSION = 5;
export const EVIDENCE_STATUSES = Object.freeze([
  'open',
  'searched',
  'body_read',
  'verified',
  'conflicting',
  'limited',
]);
export const GAP_STATUSES = Object.freeze([...EVIDENCE_STATUSES, 'blocked']);

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

function satisfiesRequiredEvidence(source, gap, extras = {}) {
  if (!sourceHasBody(source)) return false;
  if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
    return ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap))
      && documentMatchesQuerySubject(source, extras.query || gap.question, extras);
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

function gapHasObservableBody(gap = {}) {
  return Boolean(
    (gap.readSourceIds || []).length
    || (gap.supportingPassageIds || []).length
    || (gap.evidencePassageIds || []).length
    || (gap.bodies || []).length,
  );
}

export function inferEvidenceStatus(gap = {}) {
  const status = gap.status;
  const evidence = gap.evidenceStatus;
  if (status === 'resolved' || evidence === 'resolved') return 'verified';
  if (EVIDENCE_STATUSES.includes(status)) return status;
  if (EVIDENCE_STATUSES.includes(evidence)) return evidence;
  if (status === 'blocked' || status === 'missing' || evidence === 'blocked') {
    if (gapHasObservableBody(gap)) {
      return (gap.missingEvidence || []).length ? 'limited' : 'body_read';
    }
    if ((gap.searchedQueries || []).length) return 'searched';
    return 'open';
  }
  return 'open';
}

export function normalizeRepairState(gap = {}, defaults = {}) {
  const raw = gap.repairState || defaults.repairState || null;
  const legacyBlocked = gap.status === 'blocked' || Boolean(gap.blockedReason && !raw);
  if (!raw && !legacyBlocked) return null;
  const terminal = Boolean(raw?.terminal ?? raw?.exhausted ?? gap.status === 'blocked');
  if (!terminal && !raw) return null;
  const reason = raw?.reason || gap.blockedReason || 'repair_exhausted';
  return {
    ...(raw && typeof raw === 'object' ? raw : {}),
    status: raw?.status || (terminal ? 'blocked' : inferEvidenceStatus(gap)),
    reason,
    failures: Math.max(0, Number(raw?.failures ?? gap.repairFailures) || 0),
    exhausted: terminal,
    terminal,
    exhaustedAtStep: raw?.exhaustedAtStep ?? null,
    phase: raw?.phase || null,
  };
}

export function isRepairTerminal(gap = {}) {
  return Boolean(normalizeRepairState(gap)?.terminal);
}

export function evidenceStatusOf(gap = {}) {
  return inferEvidenceStatus(gap);
}

export function deriveGapOutcome(gap = {}) {
  const evidenceStatus = inferEvidenceStatus(gap);
  const repair = normalizeRepairState(gap);
  const missingEvidence = unique(gap.missingEvidence);
  const criteriaMissing = missingEvidence
    .filter((item) => String(item).startsWith('criterion:'))
    .map((item) => String(item).slice('criterion:'.length));
  const repairTerminal = Boolean(repair?.terminal);
  const repairReason = repairTerminal ? (repair.reason || gap.blockedReason || 'repair_exhausted') : null;
  let reportGrade = 'blocked';
  if (evidenceStatus === 'verified') reportGrade = 'verified';
  else if (['limited', 'body_read'].includes(evidenceStatus)) reportGrade = 'limited';
  else if (repairTerminal || ['open', 'searched'].includes(evidenceStatus)) reportGrade = 'blocked';
  const limitationKeys = [];
  if (evidenceStatus !== 'verified') {
    for (const criterion of criteriaMissing) limitationKeys.push(`slot:${gap.id}:criterion:${criterion}`);
    if (missingEvidence.includes('primary_filing')) limitationKeys.push(`slot:${gap.id}:primary_filing`);
    if (missingEvidence.includes('slot_support')) limitationKeys.push(`slot:${gap.id}:slot_support`);
    if (missingEvidence.includes('slot_partial')) limitationKeys.push(`slot:${gap.id}:slot_partial`);
  }
  if (repairTerminal) limitationKeys.push(`repair:${gap.id}:${repairReason}`);
  return {
    evidenceStatus,
    repairTerminal,
    repairReason,
    missingEvidence,
    criteriaMissing,
    reportGrade,
    limitationKeys,
    repairState: repair,
  };
}

export function normalizeGapRecord(gap = {}, defaults = {}) {
  const repairState = normalizeRepairState(gap, defaults);
  const evidenceStatus = inferEvidenceStatus(gap);
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
    evidenceStatus,
    status: evidenceStatus,
    supportingPassageIds: unique(gap.supportingPassageIds || gap.evidencePassageIds),
    contradictingPassageIds: unique(gap.contradictingPassageIds),
    confidence: Number.isFinite(gap.confidence) ? gap.confidence : null,
    evidenceCriteria: unique(gap.evidenceCriteria || defaults.evidenceCriteria),
    slotSupport: gap.slotSupport || defaults.slotSupport || null,
    missingEvidence: unique(gap.missingEvidence),
    nextQueries: unique(gap.nextQueries),
    followUpQuestions: unique(gap.followUpQuestions || defaults.followUpQuestions),
    parentGapId: gap.parentGapId || defaults.parentGapId || null,
    repairState,
    resolutionReason: gap.resolutionReason || null,
    blockedReason: repairState?.reason || null,
    repairFailures: Math.max(0, Number(gap.repairFailures) || 0),
    repairAttempts: Math.max(0, Number(gap.repairAttempts) || 0),
    exhaustedAngles: unique(gap.exhaustedAngles),
  };
}

export function evaluateGapProvenance(gap, sources = [], {
  passageIds = [],
  passages = [],
  entities = [],
  entityAliases = [],
  query = '',
  brief = {},
  profile = {},
} = {}) {
  const normalized = normalizeGapRecord(gap);
  const extras = { entities, entityAliases, query, brief, profile };
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
    || supporting.some((source) => satisfiesRequiredEvidence(source, normalized, extras));
  const criteria = evaluateEvidenceCriteria({
    gap: normalized,
    sources: supporting,
    passages,
    extras,
  });
  const requiredSatisfied = hostCoverage.satisfied && primarySatisfied && criteria.missing.length === 0;
  if (!bodies.length) missingEvidence.push('successful_body');
  if (!hostCoverage.satisfied) missingEvidence.push('required_host_body');
  if (!primarySatisfied) missingEvidence.push('primary_filing');
  missingEvidence.push(...missingEvidenceForCriteria(criteria));
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
    evidenceCriteriaEval: criteria,
  };
}

export function synthesizeGapStatus(gap, provenance = {}, slotSupport = null) {
  const support = slotSupport || provenance.slotSupport || gap.slotSupport || null;
  const missingEvidence = unique(provenance.missingEvidence);
  const repairState = normalizeRepairState(gap);
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
    repairState,
    blockedReason: repairState?.reason || null,
    confidence: null,
    resolutionReason: null,
  };

  const searched = (gap.searchedQueries || []).length > 0 || gap.status === 'searched' || gap.evidenceStatus === 'searched';
  let evidenceStatus;
  let resolutionReason = null;
  let confidence = null;
  let nextMissing = missingEvidence;

  if (!(provenance.bodies || []).length) {
    evidenceStatus = searched ? 'searched' : 'open';
  } else if ((provenance.contradicting || []).length || support?.verdict === 'conflicting') {
    evidenceStatus = 'conflicting';
    resolutionReason = 'Contradicting body evidence remains unresolved.';
  } else if (missingEvidence.length) {
    evidenceStatus = 'limited';
    resolutionReason = `Body evidence is incomplete: ${missingEvidence.join(', ')}.`;
  } else if (needsSemanticClose(gap) || isRequiredSlot(gap)) {
    const anchored = Boolean(support?.quoteAnchored && support?.method === 'llm');
    if (support?.verdict === 'supported' && anchored) {
      evidenceStatus = 'verified';
      nextMissing = [];
      confidence = 1;
      resolutionReason = 'Required slot is quote-anchored supported and provenance passed.';
    } else if (support?.verdict === 'partially_supported' && anchored) {
      evidenceStatus = 'body_read';
      nextMissing = unique([...missingEvidence, 'slot_partial']);
      resolutionReason = 'Body evidence only partially supports the required slot.';
    } else {
      evidenceStatus = 'body_read';
      nextMissing = unique([...missingEvidence, 'slot_support']);
      resolutionReason = 'Body was read but the slot is not quote-anchored supported.';
    }
  } else {
    evidenceStatus = 'verified';
    nextMissing = [];
    confidence = 1;
    resolutionReason = 'Deterministic body, source-policy, and independence requirements passed.';
  }

  const verified = evidenceStatus === 'verified';
  return {
    ...base,
    evidenceStatus,
    status: evidenceStatus,
    missingEvidence: nextMissing,
    confidence,
    resolutionReason,
    repairState: verified ? null : repairState,
    blockedReason: verified ? null : (repairState?.reason || null),
  };
}

export function evaluateGapEvidence(gap, sources = [], extras = {}) {
  const provenance = evaluateGapProvenance(gap, sources, extras);
  return synthesizeGapStatus(gap, provenance, extras.slotSupport ?? gap.slotSupport);
}

export function isMaterialGap(gap) {
  if (gap?.rollup) return false;
  return isRequiredSlot(gap)
    || gap?.priority === 'critical'
    || isRepairTerminal(gap)
    || ['open', 'searched', 'conflicting', 'limited', 'body_read'].includes(evidenceStatusOf(gap));
}

export function rollupRootGap(gaps = []) {
  const slots = gaps.filter((gap) => isRequiredSlot(gap));
  const root = gaps.find((gap) => gap.rollup || (gap.kind === 'root' && slots.length));
  if (!root || !slots.length) return gaps;
  if (slots.some((gap) => evidenceStatusOf(gap) === 'conflicting')) {
    root.evidenceStatus = 'conflicting';
    root.status = 'conflicting';
    root.resolutionReason = 'A required answer slot still has unresolved contradictory evidence.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || []));
  } else if (slots.every((gap) => evidenceStatusOf(gap) === 'verified')) {
    root.evidenceStatus = 'verified';
    root.status = 'verified';
    root.resolutionReason = 'All required answer slots were verified.';
    root.missingEvidence = [];
    root.repairState = null;
    root.blockedReason = null;
  } else if (slots.some((gap) => ['limited', 'body_read'].includes(evidenceStatusOf(gap)))) {
    root.evidenceStatus = 'limited';
    root.status = 'limited';
    root.resolutionReason = 'Required answer slots still have incomplete body evidence.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || []));
  } else if (slots.some((gap) => evidenceStatusOf(gap) === 'searched')) {
    root.evidenceStatus = 'searched';
    root.status = 'searched';
    root.resolutionReason = 'Required answer slots were searched but not yet verified.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  } else {
    root.evidenceStatus = 'open';
    root.status = 'open';
    root.resolutionReason = 'Required answer slots remain open.';
    root.missingEvidence = unique(slots.flatMap((gap) => gap.missingEvidence || ['successful_body']));
  }
  const terminal = slots.find((gap) => isRepairTerminal(gap));
  if (terminal && root.status !== 'verified') {
    root.repairState = normalizeRepairState({
      repairState: {
        terminal: true,
        exhausted: true,
        reason: terminal.repairState?.reason || terminal.blockedReason || 'repair_exhausted',
        failures: Number(terminal.repairFailures) || 0,
      },
    });
    root.blockedReason = root.repairState.reason;
  }
  return gaps;
}
