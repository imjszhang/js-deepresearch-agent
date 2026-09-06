import { createHash } from 'node:crypto';
import { isRequiredSlot } from './gap-state.mjs';

export const REPORT_PLAN_VERSION = 1;

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function canonicalKey(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？]+$/, '')
    .toLowerCase()
    .trim();
}

function claimId(prefix, text, extra = '') {
  const digest = createHash('sha256')
    .update(`${prefix}|${canonicalKey(text)}|${extra}`)
    .digest('hex')
    .slice(0, 12);
  return `${prefix}-${digest}`;
}

function sha256(value = '') {
  return createHash('sha256').update(String(value)).digest('hex');
}

function passageById(passages = [], id) {
  return passages.find((passage) => passage.id === id) || null;
}

function citationEntries(citationMap) {
  if (!citationMap) return [];
  if (citationMap instanceof Map) return [...citationMap.values()];
  return Object.values(citationMap);
}

function citationKeyForSource(citationMap, sourceId) {
  if (!citationMap || !sourceId) return null;
  const entry = citationEntries(citationMap).find((item) => item.sourceId === sourceId);
  return entry?.citationKey || null;
}

function citationsFromSupport(slotSupport = {}, passages = [], citationMap) {
  const ids = asList(slotSupport.supportingPassageIds);
  const citations = [];
  for (const id of ids) {
    const passage = passageById(passages, id);
    const sourceId = passage?.sourceId;
    const key = citationKeyForSource(citationMap, sourceId);
    if (key) citations.push(key);
  }
  for (const sourceId of [
    ...asList(slotSupport.evidenceSourceIds),
    ...asList(slotSupport.officialSourceIds),
  ]) {
    const key = citationKeyForSource(citationMap, sourceId);
    if (key) citations.push(key);
  }
  return [...new Set(citations)];
}

function citationsFromSlotFindings(slot = {}, support = {}, findings = [], citationMap) {
  let matchingSources = asList(findings)
    .filter((finding) => (
      finding.gapId === slot.id
      || (slot.contractSlotId && finding.contractSlotId === slot.contractSlotId)
      || (slot.answerSlot && finding.answerSlot === slot.answerSlot)
      || (slot.question && finding.question === slot.question)
    ))
    .flatMap((finding) => asList(finding.sources));
  const supportedSourceIds = new Set([
    ...asList(support.evidenceSourceIds),
    ...asList(support.officialSourceIds),
  ]);
  if (supportedSourceIds.size) {
    matchingSources = matchingSources.filter((source) => (
      supportedSourceIds.has(source.id) || supportedSourceIds.has(source.url)
    ));
  } else if (matchingSources.length !== 1) {
    return [];
  }
  const sourceIds = new Set(matchingSources.map((source) => source.id).filter(Boolean));
  const urls = new Set(matchingSources.map((source) => source.url).filter(Boolean));
  return citationEntries(citationMap)
    .filter((entry) => (
      sourceIds.has(entry.sourceId)
      || sourceIds.has(entry.source?.id)
      || urls.has(entry.source?.url)
    ))
    .map((entry) => entry.citationKey)
    .filter(Boolean);
}

function citationsContainingQuote(citationMap, quote = '') {
  if (!quote) return [];
  return citationEntries(citationMap)
    .filter((entry) => String(entry.source?.content || entry.source?.summary || '').includes(quote))
    .map((entry) => entry.citationKey)
    .filter(Boolean);
}

function buildSlotBoundClaim({ slot, findings = [], passages = [], citationMap }) {
  const support = slot.slotSupport && typeof slot.slotSupport === 'object' ? slot.slotSupport : {};
  const quote = String(support.quote || '').replace(/\s+/g, ' ').trim();
  const citations = [...new Set([
    ...citationsFromSupport(support, passages, citationMap),
    ...citationsFromSlotFindings(slot, support, findings, citationMap),
    ...citationsContainingQuote(citationMap, quote),
  ])];
  const supportable = (
    ['supported', 'partially_supported'].includes(support.verdict)
    && support.quoteAnchored === true
    && quote
    && citations.length > 0
  );
  if (!supportable) return null;
  const text = `${quote} [${citations.join(', ')}]`;
  return {
    id: claimId('slot', text, slot.id),
    canonicalClaimId: claimId('canon', text),
    text,
    kind: 'key_claim',
    claimRole: 'research_judgment',
    placements: ['key_findings'],
    boundSlotIds: [slot.id],
    citationKeys: citations,
    passageIds: asList(support.supportingPassageIds),
    evaluation: {
      verdict: support.verdict || (slot.status === 'verified' ? 'supported' : 'unverified'),
      method: 'report_plan',
      reason: 'required_slot',
    },
    origin: 'required_slot',
    required: true,
  };
}

function claimText(claim) {
  return typeof claim === 'string' ? claim : String(claim?.text || '');
}

export function flattenPlanClaims(plan = {}) {
  const claims = [];
  for (const text of asList(plan.summary)) {
    claims.push({
      text,
      kind: 'key_claim',
      placements: ['summary'],
      claimRole: 'research_judgment',
    });
  }
  for (const text of asList(plan.backgroundFacts)) {
    claims.push({
      text,
      kind: 'premise_fact',
      placements: ['background'],
      claimRole: 'source_attributed_fact',
    });
  }
  for (const group of asList(plan.keyFindings)) {
    for (const claim of asList(group.claims)) {
      const text = claimText(claim);
      if (typeof claim === 'string') {
        claims.push({
          text,
          kind: 'key_claim',
          placements: ['key_findings'],
          claimRole: 'research_judgment',
          groupHeading: group.heading || '',
        });
        continue;
      }
      claims.push({
        ...claim,
        text,
        kind: claim.kind || 'key_claim',
        placements: asList(claim.placements).length ? claim.placements : ['key_findings'],
        claimRole: claim.claimRole || 'research_judgment',
        groupHeading: group.heading || '',
      });
    }
  }
  return claims;
}

export function validateReportPlan(plan = {}, contract = {}) {
  const failedChecks = [];
  const fail = (check, expected, actual) => failedChecks.push({ check, expected, actual });
  const keyClaims = flattenPlanClaims(plan).filter((claim) => (
    claim.kind === 'key_claim'
    && (claim.placements || []).includes('key_findings')
    && String(claim.text || '').trim()
  ));
  const hasKeyFindingText = keyClaims.length > 0;
  const requiredSlotClaims = asList(plan.slotClaims).filter((claim) => claim.required);
  const requiredSlots = asList(contract.verifiedRequiredSlots);

  if (contract.requiredInKeyFindings || contract.narrativeMode === 'closed_judgment') {
    if (!hasKeyFindingText) {
      fail('report_missing_key_claims', { minimumKeyClaims: 1 }, { keyClaims: keyClaims.length });
    }
    if (requiredSlots.length && !hasKeyFindingText) {
      fail('report_missing_slot_claims', {
        minimumRequiredSlotClaimsInKeyFindings: 1,
      }, {
        requiredSlotClaims: requiredSlotClaims.length,
        requiredSlotClaimsInKeyFindings: 0,
      });
    }
    requiredSlots.forEach((slot, slotIndex) => {
      const boundClaims = keyClaims.filter((claim) => (
        asList(claim.boundSlotIds).includes(slot.id)
      ));
      if (boundClaims.length > 0) return;
      fail('report_missing_required_slot_claim', {
        minimumBoundClaims: 1,
        slotIndex,
        slotIdSha256: sha256(slot.id),
      }, {
        boundClaims: 0,
        slotIndex,
        slotIdSha256: sha256(slot.id),
      });
    });
  }

  return {
    ok: failedChecks.length === 0,
    flags: failedChecks.map((item) => item.check),
    failedChecks,
    keyClaimCount: keyClaims.length,
    requiredSlotClaimCount: requiredSlotClaims.length,
  };
}

export function mergeNarrativeIntoPlan(plan = {}, document = {}) {
  const slotClaims = asList(plan.slotClaims);
  const llmGroups = asList(document.keyFindings).map((group) => ({
    heading: group.heading || '',
    claims: asList(group.claims).map((claim) => {
      const normalized = typeof claim === 'string'
        ? { text: claim, kind: 'key_claim', placements: ['key_findings'] }
        : { ...claim, text: claimText(claim), kind: claim.kind || 'key_claim', placements: asList(claim.placements).length ? claim.placements : ['key_findings'] };
      const matchingSlots = slotClaims.filter((slotClaim) => (
        canonicalKey(slotClaim.text) === canonicalKey(normalized.text)
      ));
      if (!matchingSlots.length) return normalized;
      return {
        ...matchingSlots[0],
        ...normalized,
        canonicalClaimId: matchingSlots[0].canonicalClaimId,
        boundSlotIds: [...new Set(matchingSlots.flatMap((item) => item.boundSlotIds || []))],
        citationKeys: [...new Set(matchingSlots.flatMap((item) => item.citationKeys || []))],
        passageIds: [...new Set(matchingSlots.flatMap((item) => item.passageIds || []))],
        required: true,
        origin: 'required_slot',
      };
    }).filter((claim) => claim.text),
  })).filter((group) => group.claims.length);
  const boundSlotIds = new Set(
    llmGroups.flatMap((group) => group.claims.flatMap((claim) => claim.boundSlotIds || [])),
  );
  const missingRequired = slotClaims.filter((claim) => (
    !(claim.boundSlotIds || []).some((slotId) => boundSlotIds.has(slotId))
  ));
  const keyFindings = [...llmGroups];
  if (missingRequired.length) {
    keyFindings.unshift({
      heading: '',
      claims: missingRequired.map((claim) => ({
        ...claim,
        placements: ['key_findings'],
      })),
    });
  }

  return {
    ...plan,
    title: document.title || plan.title || '',
    summary: asList(document.summary),
    backgroundFacts: asList(document.backgroundFacts),
    keyFindings,
    caveats: [...new Set([
      ...asList(plan.requiredLimitations),
      ...asList(document.caveats),
    ])],
    documentOrigin: document.origin || plan.documentOrigin || 'llm',
  };
}

export function ensureKeyFindingPlacements(document = {}, claims = [], contract = {}) {
  if (contract.openJudgment || contract.incompleteContract) return document;
  const groups = asList(document.keyFindings).map((group) => ({
    heading: group.heading || '',
    claims: asList(group.claims).map(claimText).filter(Boolean),
  })).filter((group) => group.claims.length);
  if (groups.length) return { ...document, keyFindings: groups };

  const supported = claims.filter((claim) => {
    const verdict = claim.evaluation?.verdict;
    const supportedVerdict = verdict === 'supported' || verdict === 'partially_supported';
    const flags = claim.evaluation?.flags || claim.flags || [];
    return claim.kind === 'key_claim' && supportedVerdict && !flags.includes('slot_premise_rejected');
  });
  const seen = new Set();
  const recovered = [];
  for (const claim of supported) {
    const key = canonicalKey(claim.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recovered.push(claim.text);
  }
  if (!recovered.length) return { ...document, keyFindings: groups };

  return {
    ...document,
    keyFindings: [{ heading: '', claims: recovered }],
  };
}

export function documentFromPlan(plan = {}) {
  return {
    title: plan.title || 'Research Report',
    summary: asList(plan.summary),
    backgroundFacts: asList(plan.backgroundFacts),
    keyFindings: asList(plan.keyFindings).map((group) => ({
      heading: group.heading || '',
      claims: asList(group.claims).map(claimText).filter(Boolean),
    })).filter((group) => group.claims.length),
    caveats: asList(plan.caveats),
    origin: plan.documentOrigin || 'plan',
  };
}

export function buildReportPlan({
  contract = {},
  findings = [],
  passages = [],
  citationMap,
  brief = {},
  limitations = [],
  query = '',
  gaps = [],
} = {}) {
  const requiredSlots = asList(contract.verifiedRequiredSlots).length
    ? contract.verifiedRequiredSlots
    : asList(gaps).filter((gap) => isRequiredSlot(gap) && (gap.status === 'verified' || gap.status === 'closed' || gap.evidenceStatus === 'verified'));
  const slotClaims = requiredSlots.map((slot) => {
    const live = asList(gaps).find((gap) => gap.id === slot.id) || slot;
    return buildSlotBoundClaim({
      slot: live,
      findings,
      passages,
      citationMap,
    });
  }).filter(Boolean);
  const supportedSlotIds = new Set(slotClaims.flatMap((claim) => claim.boundSlotIds || []));
  const unsupportedRequiredSlots = requiredSlots.filter((slot) => !supportedSlotIds.has(slot.id));
  const requiredLimitations = unsupportedRequiredSlots.map((slot) => (
    `Required report slot ${slot.id} lacks an anchored, cited answer in the frozen contract.`
  ));

  return {
    schemaVersion: REPORT_PLAN_VERSION,
    query: query || brief.query || '',
    title: '',
    contract,
    brief,
    findings,
    passages,
    limitations,
    slotClaims,
    summary: [],
    backgroundFacts: [],
    keyFindings: slotClaims.length && contract.requiredInKeyFindings
      ? [{ heading: '', claims: slotClaims }]
      : [],
    requiredLimitations,
    unsupportedRequiredSlotIds: unsupportedRequiredSlots.map((slot) => slot.id),
    caveats: [
      ...asList(limitations).map((item) => item.text || item.summary || item).filter(Boolean),
      ...requiredLimitations,
    ],
    requiredClaimIds: slotClaims.map((claim) => claim.id),
  };
}
