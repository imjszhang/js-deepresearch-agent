import { extractPublishedDate } from './body-quality.mjs';
import { buildClaimEvaluation } from './claim-quality.mjs';

function sourcePublishedAt(source = {}) {
  const explicit = source.publishedAt || source.date || source.published;
  if (explicit) {
    const value = String(explicit).trim();
    if (/^\d{4}-\d{2}(-\d{2})?/.test(value)) return value.slice(0, 10);
  }
  return extractPublishedDate(source.title, source.summary, source.content, source.snippet, source.publishedAt);
}

function passageMentionsCutoff(text, asOf) {
  const hay = String(text || '');
  if (!hay) return false;
  if (asOf.date && hay.includes(asOf.date)) return true;
  if (asOf.label && hay.includes(asOf.label)) return true;
  const yearMonth = String(asOf.date || '').slice(0, 7);
  return Boolean(yearMonth && hay.includes(yearMonth));
}

export function sourceUsableForAsOf(source = {}, asOf = null, { passageText = '' } = {}) {
  if (!asOf?.date) return { usable: true, applicable: false, reason: 'not_applicable' };
  const published = sourcePublishedAt(source);
  if (!published) return { usable: false, applicable: true, reason: 'unknown_date' };
  if (published <= asOf.date) return { usable: true, applicable: true, reason: 'within_cutoff' };
  if (passageMentionsCutoff(passageText || source.content || source.summary, asOf)) {
    return { usable: true, applicable: true, reason: 'retrospective', annotated: true };
  }
  return { usable: false, applicable: true, reason: 'post_cutoff' };
}

export function applyAsOfGate(claims = [], {
  asOf = null,
  sources = [],
  passages = [],
} = {}) {
  if (!asOf?.date) return claims;
  const sourceById = new Map((sources || []).map((source) => [source.id || source.url, source]));
  return claims.map((claim) => {
    if (claim.kind !== 'key_claim') return claim;
    const citedIds = claim.citedSourceIds || [];
    if (!citedIds.length) return claim;
    const cited = citedIds.map((id) => sourceById.get(id)).filter(Boolean);
    const citedPassages = (passages || []).filter((passage) => citedIds.includes(passage.sourceId));
    const usable = cited.some((source) => {
      const text = citedPassages.filter((passage) => passage.sourceId === (source.id || source.url))
        .map((passage) => passage.text)
        .join('\n');
      return sourceUsableForAsOf(source, asOf, { passageText: text }).usable;
    });
    if (usable) return claim;
    const next = {
      ...claim,
      flags: [...new Set([...(claim.flags || []), 'as_of_incompatible'])],
    };
    next.evaluation = buildClaimEvaluation(next, {
      method: 'rules',
      origin: 'as_of_gate',
    });
    return next;
  });
}

export function slotEvidenceLimitations(gaps = []) {
  const notes = [];
  for (const gap of (gaps || []).filter((item) => !item.rollup && item.requiredSlot)) {
    const label = gap.answerSlot || gap.id;
    if (['verified', 'resolved'].includes(gap.status)) continue;
    if (['limited', 'body_read'].includes(gap.status)) {
      notes.push(`Slot ${label} has ${gap.status} evidence only (media paraphrase / not verified from a first-party filing). Do not treat it as confirmed in Summary or Key Findings.`);
    }
    if (['blocked', 'missing', 'open', 'searched'].includes(gap.status) || gap.slotSupport?.verdict === 'unverifiable') {
      notes.push(`Slot ${label} is ${gap.status || 'unresolved'} and must stay in Caveats/Limitations, not as a confirmed finding.`);
    }
  }
  return notes;
}

export function resolveCompletionStatus({
  readiness = null,
  stopReason = null,
  gaps = [],
} = {}) {
  if (stopReason === 'user_cancelled') return 'cancelled';
  const openRequired = (gaps || []).filter((gap) => (
    gap?.requiredSlot
    && !gap.rollup
    && !['verified', 'resolved'].includes(gap.status)
  ));
  if (readiness) {
    if (readiness.pass && openRequired.length === 0) return 'complete';
    return 'incomplete';
  }
  if (['safety_cap', 'budget_exhausted'].includes(stopReason) && openRequired.length) {
    return 'incomplete';
  }
  return 'complete';
}
