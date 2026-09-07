import {
  deriveGapOutcome,
  evidenceStatusOf,
  isRequiredSlot,
} from './gap-state.mjs';
import { stripInternalReferenceTokens } from './citations.mjs';
import { normalizeCaveatKey } from './report-assembler.mjs';

function addItem(items, key, kind, text, gapId = null) {
  const value = String(text || '').trim();
  if (!key || !value) return;
  items.push({ key, kind, gapId, text: value });
}

function criterionText(label, criterion, gap = {}) {
  if (criterion === 'first_party') {
    return `Slot ${label}: no first-party or official source was successfully read.`;
  }
  if (criterion === 'filing') {
    return `Slot ${label}: no filing or primary disclosure was verified from a required host.`;
  }
  if (criterion === 'numeric') {
    return `Slot ${label}: no citable numeric evidence was found in read bodies.`;
  }
  if (criterion === 'user_named') {
    const hosts = (gap.requiredHosts || []).join(', ');
    return hosts
      ? `Slot ${label}: user-named host (${hosts}) was not successfully read.`
      : `Slot ${label}: a user-named source was not successfully read.`;
  }
  if (criterion === 'mainstream_media') {
    return `Slot ${label}: mainstream media corroboration is missing.`;
  }
  return `Slot ${label}: required evidence criterion ${criterion} is missing.`;
}

function slotSupportText(gap, outcome) {
  const label = gap.answerSlot || gap.id;
  const missing = outcome.missingEvidence || [];
  const firstPartyRequired = (gap.evidenceCriteria || []).includes('first_party');
  const firstPartyMissing = missing.includes('criterion:first_party');
  if (firstPartyRequired && !firstPartyMissing && missing.includes('slot_support')) {
    return `Slot ${label}: first-party bodies were read but they are not sufficient to support the required judgment. Do not treat the strategic conclusion as confirmed.`;
  }
  if (missing.includes('slot_partial')) {
    return `Slot ${label}: body evidence only partially supports the required slot.`;
  }
  return `Slot ${label}: bodies were read but the required slot is not quote-anchored supported.`;
}

export function buildResearchLimitations({
  gaps = [],
  readiness = null,
  stopReason = null,
  stopDetail = null,
  budget = null,
  strategy = 'focused',
  movedClaims = [],
  snippetOnlyKeys = [],
  contractUnavailable = false,
  secondaryOnly = false,
  reprintOnly = false,
  blockedHosts = [],
  unmetRequiredHosts = [],
  degraded = false,
  extra = [],
} = {}) {
  const items = [];
  const required = (gaps || []).filter((gap) => isRequiredSlot(gap));
  const openRequired = required.filter((gap) => !['verified', 'resolved'].includes(evidenceStatusOf(gap)));

  for (const gap of required) {
    const outcome = deriveGapOutcome(gap);
    const label = gap.answerSlot || gap.id;
    if (outcome.evidenceStatus === 'verified') {
      if (outcome.repairTerminal) {
        addItem(items, `repair:${gap.id}:${outcome.repairReason}`, 'repair', `Slot ${label}: evidence repair exhausted (${outcome.repairReason}); do not treat it as confirmed.`, gap.id);
      }
      continue;
    }
    for (const criterion of outcome.criteriaMissing) {
      addItem(items, `slot:${gap.id}:criterion:${criterion}`, 'slot', criterionText(label, criterion, gap), gap.id);
    }
    if ((outcome.missingEvidence || []).includes('primary_filing') && !outcome.criteriaMissing.includes('filing')) {
      addItem(items, `slot:${gap.id}:primary_filing`, 'slot', `Slot ${label}: no filing or primary disclosure was verified from a required host.`, gap.id);
    }
    if ((outcome.missingEvidence || []).some((item) => item === 'slot_support' || item === 'slot_partial')) {
      addItem(items, `slot:${gap.id}:slot_support`, 'slot', slotSupportText(gap, outcome), gap.id);
    } else if (['open', 'searched'].includes(outcome.evidenceStatus) || gap.slotSupport?.verdict === 'unverifiable') {
      addItem(items, `slot:${gap.id}:unresolved`, 'slot', `Slot ${label} is ${outcome.evidenceStatus || 'unresolved'} and must stay in Caveats/Limitations, not as a confirmed finding.`, gap.id);
    }
    if (outcome.repairTerminal) {
      addItem(items, `repair:${gap.id}:${outcome.repairReason}`, 'repair', `Slot ${label}: evidence repair exhausted (${outcome.repairReason}); do not treat it as confirmed.`, gap.id);
    }
  }

  if (openRequired.length) {
    addItem(
      items,
      'open_required_count',
      'gap',
      `${openRequired.length} required answer slot${openRequired.length === 1 ? '' : 's'} remain unresolved.`,
    );
  }

  if (contractUnavailable) {
    addItem(items, 'contract_unavailable', 'process', 'The research contract could not be planned; required slots were not available to verify.');
  }
  if (degraded) {
    addItem(items, 'degraded', 'process', 'Evidence gathering was cut short before completion; treat the collected evidence as incomplete and state remaining uncertainty explicitly.');
  }
  if ((strategy === 'focused' || strategy === 'exploratory') && snippetOnlyKeys.length) {
    addItem(
      items,
      'snippet_only',
      'process',
      `Sources ${snippetOnlyKeys.map((key) => `[${key}]`).join(', ')} are search snippets only and cannot verify Summary or Key Findings facts. Mark those facts Unverified or move them to Caveats.`,
    );
  }
  if (stopReason === 'budget_exhausted' || budget?.stopReason) {
    const reason = stopReason || budget.stopReason;
    addItem(items, 'budget_exhausted', 'process', `The ${reason} budget was exhausted; remaining research actions were not scheduled.`);
  }
  if (stopDetail === 'query_planner_exhausted') {
    addItem(items, 'query_planner_exhausted', 'process', 'The search query planner could not produce a valid query; remaining gaps were skipped or blocked.');
  }
  if (secondaryOnly || reprintOnly) {
    addItem(items, 'secondary_only', 'process', 'Some conclusions rest only on secondary or reprint sources and cannot be treated as primary-source verified.');
  }
  for (const host of blockedHosts || []) {
    const hostname = host.hostname || host;
    const reason = host.reason || 'host_circuit_open';
    if (!hostname) continue;
    addItem(items, `circuit:${hostname}`, 'transport', `Circuit is open for ${hostname} (${reason}); later HTTP reads were skipped.`);
  }
  for (const item of unmetRequiredHosts || []) {
    const host = item.host || item.hostname || item;
    const reason = item.reason || 'not_retrieved';
    if (!host) continue;
    if (reason === 'body_rejected') {
      addItem(
        items,
        `required_host:${host}:${reason}`,
        'transport',
        `Required host ${host} was retrieved but the body was rejected as evidence.`,
      );
      continue;
    }
    addItem(items, `required_host:${host}:${reason}`, 'transport', `Required host ${host} was not retrieved (${reason}).`);
  }
  if (readiness && !readiness.pass && (readiness.failures || []).length) {
    addItem(
      items,
      'readiness_failures',
      'process',
      `The report cannot support: ${readiness.failures.map((failure) => failure.message).filter(Boolean).join('; ')}`,
    );
  }

  for (const text of extra || []) {
    addItem(items, `extra:${normalizeCaveatKey(text)}`, 'extra', text);
  }
  for (const entry of movedClaims || []) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    const safeText = stripInternalReferenceTokens(text);
    if (!safeText) continue;
    if (typeof entry === 'object' && entry?.verifiedSlot) {
      addItem(items, `wording:${normalizeCaveatKey(safeText)}`, 'wording', `Discarded report wording: ${safeText}`);
      continue;
    }
    addItem(items, `moved:${normalizeCaveatKey(safeText)}`, 'moved', `Insufficient direct evidence for: ${safeText}`);
  }

  const byKey = new Map();
  for (const item of items) {
    if (!byKey.has(item.key)) byKey.set(item.key, item);
  }
  const seen = new Set();
  const unique = [];
  for (const item of byKey.values()) {
    const key = normalizeCaveatKey(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return {
    items: unique,
    limitations: unique.map((item) => item.text),
    limitationKeys: unique.map((item) => item.key),
  };
}

export function slotEvidenceLimitations(gaps = [], brief = {}) {
  return buildResearchLimitations({ gaps, brief }).items
    .filter((item) => item.kind === 'slot' || item.kind === 'repair')
    .map((item) => item.text);
}
