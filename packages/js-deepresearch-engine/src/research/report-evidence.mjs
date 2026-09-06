import { isSuccessfulBody } from './body-quality.mjs';
import { buildClaimEvaluation } from './claim-quality.mjs';
import { sourceSatisfiesCriterion } from './evidence-criteria.mjs';
import { deriveGapOutcome, evidenceStatusOf, isRepairTerminal, isRequiredSlot } from './gap-state.mjs';

const VERIFIED_STATUSES = new Set(['verified', 'resolved']);
const LIMITED_STATUSES = new Set(['limited', 'body_read']);
const BLOCKED_EVIDENCE_STATUSES = new Set(['missing', 'open', 'searched']);

function gapById(gaps = []) {
  return new Map((gaps || []).map((gap) => [gap.id, gap]));
}

export function isJudgmentContext(gaps = [], brief = {}) {
  if (brief?.queryShape === 'judgment') return true;
  return (gaps || []).some((gap) => isRequiredSlot(gap) && /judgment/i.test(String(gap.answerSlot || gap.contractSlotId || '')));
}

export function hasOpenRequiredSlot(gaps = []) {
  return (gaps || []).some((gap) => (
    isRequiredSlot(gap) && !['verified', 'resolved'].includes(evidenceStatusOf(gap))
  ));
}

export function hasOpenJudgmentSlot(gaps = [], brief = {}) {
  return isJudgmentContext(gaps, brief) && hasOpenRequiredSlot(gaps);
}

export function evidenceGradeForGap(gap) {
  if (!gap || gap.rollup) return null;
  const outcome = deriveGapOutcome(gap);
  if (VERIFIED_STATUSES.has(outcome.evidenceStatus)) return 'verified';
  if (LIMITED_STATUSES.has(outcome.evidenceStatus)) return 'limited';
  if (isRepairTerminal(gap) || BLOCKED_EVIDENCE_STATUSES.has(outcome.evidenceStatus) || gap.slotSupport?.verdict === 'unverifiable') {
    return 'blocked';
  }
  return 'blocked';
}

function findingHasUsableEvidence(finding, { allowSnippets = false } = {}) {
  return (finding.sources || []).some((source) => {
    if (isSuccessfulBody(source)) return true;
    if (!allowSnippets) return false;
    return Boolean(String(source?.snippet || '').trim() || source?.url);
  });
}

export function findingHasFirstPartyBody(finding = {}) {
  return (finding.sources || []).some((source) => (
    isSuccessfulBody(source) && sourceSatisfiesCriterion(source, 'first_party')
  ));
}

function sourceById(findings = []) {
  return (findings || []).flatMap((finding) => finding.sources || []);
}

export function claimHasIndependentFirstPartyEvidence(claim = {}, findings = []) {
  const flags = claim.evaluation?.flags || claim.flags || [];
  if (flags.some((flag) => ['uncited', 'unresolved_citation', 'snippet_only', 'missing_direct_evidence'].includes(flag))) {
    return false;
  }
  if (claim.evaluation?.verdict && claim.evaluation.verdict !== 'supported') return false;
  const cited = claim.citedSourceIds || [];
  if (!cited.length) return false;
  const sources = sourceById(findings);
  return cited.some((id) => {
    const source = sources.find((item) => (item.id || item.url) === id);
    return source && isSuccessfulBody(source) && sourceSatisfiesCriterion(source, 'first_party');
  });
}

export function partitionFindingsForReport({ findings = [], gaps = [], strategy = 'focused', brief = {} } = {}) {
  const byId = gapById(gaps);
  const verified = [];
  const limited = [];
  const blocked = [];
  const backgroundVerified = [];
  const allowSnippets = strategy === 'quick';
  const openJudgment = hasOpenJudgmentSlot(gaps, brief);
  for (const finding of findings) {
    const gap = byId.get(finding.gapId);
    const owner = owningRequiredGap(finding, gaps);
    let grade = evidenceGradeForGap(gap);
    if (!gap || !gap.requiredSlot) {
      grade = findingHasUsableEvidence(finding, { allowSnippets }) ? 'verified' : 'blocked';
    }
    if (owner && owner !== gap) {
      grade = gradeCeiling(grade || 'verified', evidenceGradeForGap(owner) || 'blocked');
    }
    const tagged = { ...finding, evidenceGrade: grade };
    if (openJudgment && findingHasFirstPartyBody(finding)) {
      backgroundVerified.push({ ...finding, evidenceGrade: 'background' });
    }
    if (grade === 'verified') verified.push(tagged);
    else if (grade === 'limited') limited.push(tagged);
    else blocked.push(tagged);
  }
  return { verified, limited, blocked, backgroundVerified };
}

function sourceToGaps(findings = [], gaps = []) {
  const byId = gapById(gaps);
  const map = new Map();
  for (const finding of findings) {
    const gap = byId.get(finding.gapId);
    if (!gap || gap.rollup) continue;
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      if (!id) continue;
      const list = map.get(id) || [];
      list.push(gap);
      map.set(id, list);
    }
  }
  return map;
}

function flagClaim(claim, flag) {
  const next = {
    ...claim,
    flags: [...new Set([...(claim.flags || []), flag])],
  };
  next.evaluation = buildClaimEvaluation(next, {
    method: 'rules',
    origin: 'slot_status_gate',
  });
  return next;
}

function addFlags(claim, extra = []) {
  const flags = [...new Set([...(claim.flags || []), ...extra])];
  return {
    ...claim,
    flags,
    evaluation: {
      ...(claim.evaluation || {}),
      flags: [...new Set([...(claim.evaluation?.flags || []), ...extra])],
    },
  };
}

function uniqueGaps(gaps = []) {
  return [...new Map(gaps.filter(Boolean).map((gap) => [gap.id, gap])).values()];
}

export function owningRequiredGap(finding, gaps = []) {
  const byId = gapById(gaps);
  const direct = byId.get(finding?.gapId);
  if (direct?.requiredSlot) return direct;
  const parentId = finding?.parentGapId || direct?.parentGapId;
  if (parentId && byId.get(parentId)?.requiredSlot) return byId.get(parentId);
  const contractId = finding?.contractSlotId || direct?.contractSlotId;
  if (contractId) {
    return (gaps || []).find((gap) => gap.requiredSlot && gap.contractSlotId === contractId) || null;
  }
  return null;
}

function gradeRank(grade) {
  if (grade === 'verified') return 2;
  if (grade === 'limited') return 1;
  return 0;
}

function gradeCeiling(own, parent) {
  if (!parent) return own;
  return gradeRank(own) <= gradeRank(parent) ? own : parent;
}

function citationFindingsForClaim(claim, findings = []) {
  return (claim.citationKeys || []).flatMap((key) => {
    const findingIndex = Number(String(key).split('.')[0]) - 1;
    if (!Number.isInteger(findingIndex) || findingIndex < 0) return [];
    return findings[findingIndex] ? [findings[findingIndex]] : [];
  });
}

function citationGapsForClaim(claim, findings, byId, gaps = []) {
  const cited = citationFindingsForClaim(claim, findings).flatMap((finding) => {
    const gap = byId.get(finding.gapId);
    const owner = owningRequiredGap(finding, gaps);
    return [gap, owner];
  });
  return uniqueGaps(cited);
}

function boundSlotsForClaim(claim, findings, gaps, mapped, byId) {
  const ids = claim.citedSourceIds || [];
  const citationGaps = citationGapsForClaim(claim, findings, byId, gaps);
  const sourceGaps = ids.flatMap((id) => mapped.get(id) || []);
  const citedOwners = citationFindingsForClaim(claim, findings)
    .map((finding) => owningRequiredGap(finding, gaps));
  return uniqueGaps([
    ...(citationGaps.length ? citationGaps : sourceGaps),
    ...citedOwners,
  ]).filter((gap) => gap.requiredSlot);
}

function isBlockedSlot(gap) {
  return isRepairTerminal(gap) || BLOCKED_EVIDENCE_STATUSES.has(evidenceStatusOf(gap));
}

function isLimitedSlot(gap) {
  return LIMITED_STATUSES.has(evidenceStatusOf(gap));
}

export function applySlotStatusToClaims(claims = [], { gaps = [], findings = [], brief = {} } = {}) {
  const mapped = sourceToGaps(findings, gaps);
  const byId = gapById(gaps);
  const openJudgment = hasOpenJudgmentSlot(gaps, brief);
  return claims.map((claim) => {
    const slots = boundSlotsForClaim(claim, findings, gaps, mapped, byId);
    if (claim.kind === 'premise_fact') {
      const bound = {
        ...claim,
        boundSlotIds: slots.map((gap) => gap.id),
        claimRole: claim.claimRole || 'source_attributed_fact',
      };
      if (claimHasIndependentFirstPartyEvidence(bound, findings) && bound.evaluation?.verdict === 'supported') {
        return addFlags(bound, ['slot_premise_exempt']);
      }
      const flags = bound.evaluation?.flags || bound.flags || [];
      const weak = flags.some((flag) => (
        ['uncited', 'unresolved_citation', 'snippet_only', 'missing_direct_evidence'].includes(flag)
      ));
      if (weak || (openJudgment && !claimHasIndependentFirstPartyEvidence(bound, findings))) {
        return flagClaim(bound, 'slot_premise_rejected');
      }
      return bound;
    }
    if (claim.kind !== 'key_claim') return claim;
    if (!slots.length) return claim;
    const bound = {
      ...claim,
      boundSlotIds: slots.map((gap) => gap.id),
    };
    if (
      openJudgment
      && bound.claimRole === 'source_attributed_fact'
      && bound.evaluation?.verdict === 'supported'
      && claimHasIndependentFirstPartyEvidence(bound, findings)
    ) {
      return addFlags(bound, ['slot_fact_exempt']);
    }
    if (slots.every((gap) => isBlockedSlot(gap))) {
      return flagClaim(bound, 'slot_blocked');
    }
    if (
      slots.every((gap) => isLimitedSlot(gap) || isBlockedSlot(gap))
      && slots.some((gap) => isLimitedSlot(gap))
    ) {
      return flagClaim(bound, 'slot_limited');
    }
    return bound;
  });
}
