import { isSuccessfulBody } from './body-quality.mjs';
import { buildClaimEvaluation } from './claim-quality.mjs';

const VERIFIED_STATUSES = new Set(['verified', 'resolved']);
const LIMITED_STATUSES = new Set(['limited', 'body_read']);
const BLOCKED_STATUSES = new Set(['blocked', 'missing', 'open', 'searched']);

function gapById(gaps = []) {
  return new Map((gaps || []).map((gap) => [gap.id, gap]));
}

export function evidenceGradeForGap(gap) {
  if (!gap || gap.rollup) return null;
  if (VERIFIED_STATUSES.has(gap.status)) return 'verified';
  if (LIMITED_STATUSES.has(gap.status)) return 'limited';
  if (BLOCKED_STATUSES.has(gap.status) || gap.slotSupport?.verdict === 'unverifiable') return 'blocked';
  return 'blocked';
}

function findingHasUsableEvidence(finding, { allowSnippets = false } = {}) {
  return (finding.sources || []).some((source) => {
    if (isSuccessfulBody(source)) return true;
    if (!allowSnippets) return false;
    return Boolean(String(source?.snippet || '').trim() || source?.url);
  });
}

export function partitionFindingsForReport({ findings = [], gaps = [], strategy = 'focused' } = {}) {
  const byId = gapById(gaps);
  const verified = [];
  const limited = [];
  const blocked = [];
  const allowSnippets = strategy === 'quick';
  for (const finding of findings) {
    const gap = byId.get(finding.gapId);
    let grade = evidenceGradeForGap(gap);
    if (!gap || !gap.requiredSlot) {
      grade = findingHasUsableEvidence(finding, { allowSnippets }) ? 'verified' : 'blocked';
    }
    const tagged = { ...finding, evidenceGrade: grade };
    if (grade === 'verified') verified.push(tagged);
    else if (grade === 'limited') limited.push(tagged);
    else blocked.push(tagged);
  }
  return { verified, limited, blocked };
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

function uniqueGaps(gaps = []) {
  return [...new Map(gaps.filter(Boolean).map((gap) => [gap.id, gap])).values()];
}

function citationGapsForClaim(claim, findings, byId) {
  const cited = (claim.citationKeys || []).flatMap((key) => {
    const findingIndex = Number(String(key).split('.')[0]) - 1;
    if (!Number.isInteger(findingIndex) || findingIndex < 0) return [];
    const gap = byId.get(findings[findingIndex]?.gapId);
    return gap ? [gap] : [];
  });
  return uniqueGaps(cited);
}

export function applySlotStatusToClaims(claims = [], { gaps = [], findings = [] } = {}) {
  const mapped = sourceToGaps(findings, gaps);
  const byId = gapById(gaps);
  return claims.map((claim) => {
    if (claim.kind !== 'key_claim') return claim;
    const ids = claim.citedSourceIds || [];
    const citationGaps = citationGapsForClaim(claim, findings, byId);
    const sourceGaps = ids.flatMap((id) => mapped.get(id) || []);
    const slots = (citationGaps.length ? citationGaps : uniqueGaps(sourceGaps))
      .filter((gap) => gap.requiredSlot);
    if (!slots.length) return claim;
    if (slots.every((gap) => BLOCKED_STATUSES.has(gap.status))) {
      return flagClaim(claim, 'slot_blocked');
    }
    if (
      slots.every((gap) => LIMITED_STATUSES.has(gap.status) || BLOCKED_STATUSES.has(gap.status))
      && slots.some((gap) => LIMITED_STATUSES.has(gap.status))
    ) {
      return flagClaim(claim, 'slot_limited');
    }
    return claim;
  });
}
