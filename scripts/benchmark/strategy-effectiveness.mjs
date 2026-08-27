import { mapHistoricalStrategy, parseCitations, sourceHasFetchedBody } from 'js-deepresearch-engine';
import {
  auditClaim,
  buildAuditCitationMap,
  classifyAuditedSource,
  completeSlots,
  emptyBulletLines,
  extractLabeledNarrative,
  extractNarrativeText,
  headingCount,
  MIN_NARRATIVE_CHARS,
  passageHashMismatches,
  passageOffsetMismatches,
  selectNarrativeClaims,
  sourceHasRealBody,
} from './claim-audit.mjs';
import { splitLlmCost } from './extract-run-stats.mjs';
import { matchQueryBattery } from './query-battery.mjs';

const HARD_STOP_RE = /budget_exhausted|max_budget|maxBudget|max_steps|maxSteps|max_llm_tokens|token_limit|llmTokens|hard_cap|hardCap/i;
const DEFINITE_SLOT_STATUSES = new Set(['completed', 'missing', 'blocked']);

function check(id, pass, detail) {
  return { id, pass, detail };
}

function normalizeStrategy(strategy, { meta, trace } = {}) {
  return mapHistoricalStrategy(strategy, { meta, trace, settings: meta?.settings }) || strategy || '';
}

function allCitations(report, claims) {
  const keys = [...parseCitations(report)];
  for (const claim of claims) {
    for (const key of claim.citationKeys || []) keys.push(key);
  }
  return [...new Set(keys)];
}

export function hasHardStop(quality = {}) {
  const flags = Array.isArray(quality.flags) ? quality.flags : [];
  if (flags.some((flag) => HARD_STOP_RE.test(String(flag)))) return true;
  return [quality.stopReason, quality.budget?.controllerStopReason, quality.budget?.stopReason]
    .some((reason) => reason && HARD_STOP_RE.test(String(reason)));
}

export function auditReportIntegrity(report = '', query = '') {
  const labeled = extractLabeledNarrative(report);
  const narrative = extractNarrativeText(report, query);
  const emptyBullets = emptyBulletLines(report);
  const headings = headingCount(report);
  const narrativeChars = labeled.length || narrative.length;
  const checks = [
    check('has_heading', headings > 0, headings > 0 ? `${headings} markdown headings.` : 'Report has no markdown heading.'),
    check('no_empty_bullets', emptyBullets.length === 0, emptyBullets.length
      ? `${emptyBullets.length} empty bullet(s).`
      : 'No empty bullets.'),
    check('narrative_present', labeled.length > 0, labeled.length
      ? 'Summary / Key Findings is present.'
      : 'Summary / Key Findings is empty.'),
    check(
      'narrative_min_chars',
      narrativeChars >= MIN_NARRATIVE_CHARS,
      `${narrativeChars} narrative characters (min ${MIN_NARRATIVE_CHARS}).`,
    ),
  ];
  return {
    pass: checks.every((item) => item.pass),
    checks,
    counts: {
      headingCount: headings,
      emptyBulletCount: emptyBullets.length,
      narrativeChars,
    },
  };
}

export function auditCitationIntegrity({ report = '', claims = [], citationMap, sources = [] }) {
  const keys = allCitations(report, claims);
  const unresolved = keys.filter((key) => !citationMap.has(key));
  const missingIds = [];
  for (const claim of claims) {
    for (const id of claim.citedSourceIds || []) {
      if (id && !sources.some((source) => source.id === id)) missingIds.push(id);
    }
  }
  const checks = [
    check(
      'citations_resolve',
      unresolved.length === 0,
      unresolved.length ? `Unresolved citations: ${unresolved.join(', ')}.` : 'All citation keys resolve.',
    ),
    check(
      'cited_source_ids_exist',
      missingIds.length === 0,
      missingIds.length ? `Missing citedSourceIds: ${missingIds.join(', ')}.` : 'Cited source ids exist.',
    ),
  ];
  return {
    pass: checks.every((item) => item.pass),
    checks,
    counts: {
      citationCount: keys.length,
      resolved: keys.length - unresolved.length,
      unresolved: unresolved.length,
      missingSourceIds: missingIds.length,
    },
    unresolved,
    missingIds,
  };
}

export function auditEvidenceProvenance(sources = []) {
  const records = Array.isArray(sources) ? sources : [];
  let realBodies = 0;
  let summaries = 0;
  let snippets = 0;
  let wafRejected = 0;
  const presentedWaf = [];
  for (const source of records) {
    const klass = classifyAuditedSource(source);
    if (klass === 'waf_or_error') {
      wafRejected += 1;
      if (sourceHasFetchedBody(source)) presentedWaf.push(source);
      continue;
    }
    if (klass === 'source_body' && sourceHasRealBody(source)) realBodies += 1;
    else if (klass === 'source_summary') summaries += 1;
    else snippets += 1;
  }
  const checks = [
    check(
      'no_waf_as_body',
      presentedWaf.length === 0,
      presentedWaf.length
        ? `${presentedWaf.length} fetched source(s) are WAF or error shells.`
        : 'No WAF or error shell is counted as a fetched body.',
    ),
  ];
  return {
    pass: checks.every((item) => item.pass),
    checks,
    counts: {
      realBodies,
      summaries,
      snippets,
      wafRejected,
      sourceCount: records.length,
    },
  };
}

export function evaluateProcessContract(strategy, {
  battery,
  usage = {},
  cost = {},
  quality = {},
  reportIntegrity,
  provenance,
  slots,
  labeledNarrative = '',
} = {}) {
  const checks = [];
  const sourceReads = Number(usage.sourceReads ?? cost.sourceReads) || 0;
  const explorationTokens = cost.explorationTokens == null ? (Number(cost.llmTokens) || 0) : cost.explorationTokens;
  const minTokens = Number(quality?.budget?.minLlmTokens || quality?.budget?.targetLlmTokens) || 0;
  const requiredSlots = (slots?.slots || []).filter((slot) => slot.required);
  const criticalSlots = (slots?.slots || []).filter((slot) => slot.critical);
  const applicable = Boolean(slots?.applicable);

  if (strategy === 'quick') {
    checks.push(check('source_reads_zero', sourceReads === 0, `sourceReads=${sourceReads}.`));
    checks.push(check(
      'snippet_only_sources',
      (provenance.counts.realBodies + provenance.counts.summaries) === 0,
      'Quick sources must be snippet_only or missing.',
    ));
    checks.push(check('summary_nonempty', labeledNarrative.length > 0, 'Quick Summary must be non-empty.'));
    checks.push(check(
      'no_body_class_evidence',
      provenance.counts.realBodies === 0 && provenance.counts.summaries === 0,
      'Quick must not present body-class or summary sources as evidence.',
    ));
  } else if (strategy === 'focused') {
    checks.push(check('source_reads_at_least_one', sourceReads >= 1, `sourceReads=${sourceReads}.`));
    checks.push(check(
      'real_body_or_summary',
      provenance.counts.realBodies + provenance.counts.summaries > 0,
      'Focused needs at least one real body or summary that is not a WAF shell.',
    ));
    checks.push(check(
      'required_slots_completed',
      !applicable || requiredSlots.every((slot) => slot.status === 'completed'),
      applicable ? 'Every required slot must be completed.' : 'No battery matched; required slots are not applicable.',
    ));
    checks.push(check('report_integrity', reportIntegrity.pass, 'Focused requires reportIntegrity to pass.'));
    checks.push(check(
      'required_numbers',
      !applicable || requiredSlots.every((slot) => {
        const numbersCheck = slot.checks.find((item) => item.id === 'requires_numbers');
        return !numbersCheck || numbersCheck.pass;
      }),
      'Required numeric slots must have numbers in cited evidence.',
    ));
    checks.push(check(
      'required_source_policy',
      !applicable || requiredSlots.every((slot) => {
        const policyCheck = slot.checks.find((item) => item.id === 'source_policy');
        return !policyCheck || policyCheck.pass;
      }),
      'Required first-party slots must cite a policy host.',
    ));
  } else if (strategy === 'exploratory') {
    checks.push(check(
      'exploration_token_floor_or_hard_stop',
      minTokens === 0 || explorationTokens >= minTokens || hasHardStop(quality),
      minTokens
        ? `explorationTokens=${explorationTokens}, min=${minTokens}, hardStop=${hasHardStop(quality)}.`
        : 'No exploration token floor recorded.',
    ));
    checks.push(check(
      'critical_slots_definite',
      !applicable || criticalSlots.every((slot) => DEFINITE_SLOT_STATUSES.has(slot.status)),
      'Every critical slot has status completed, missing, or blocked.',
    ));
    checks.push(check(
      'critical_slots_not_missing',
      !applicable || criticalSlots.every((slot) => slot.status !== 'missing'),
      'Missing critical slots fail exploratory readiness.',
    ));
    checks.push(check(
      'first_party_gates',
      !applicable || [...requiredSlots, ...criticalSlots]
        .filter((slot, index, list) => list.findIndex((item) => item.id === slot.id) === index)
        .every((slot) => {
          const policyCheck = slot.checks.find((item) => item.id === 'source_policy');
          return !policyCheck || slot.status !== 'blocked' || policyCheck.pass;
        }),
      'Critical or required first-party slots must not be blocked by host policy.',
    ));
    checks.push(check(
      'freshness_gates',
      !applicable || [...requiredSlots, ...criticalSlots].every((slot) => {
        const freshness = slot.checks.find((item) => item.id === 'freshness');
        return !freshness || freshness.pass;
      }),
      'Slots with maxAgeDays must have a fresh dated source.',
    ));
  } else {
    checks.push(check('no_process_contract', true, 'No published process contract for this strategy.'));
  }

  return {
    pass: checks.length > 0 && checks.every((item) => item.pass),
    checks,
  };
}

function structuralIssues({
  report,
  citation,
  passages = [],
  sources = [],
}) {
  const issues = [];
  if (!String(report || '').trim()) issues.push('missing_report');
  if (citation.unresolved.length && citation.counts.citationCount > 0) issues.push('dangling_citations');
  if (citation.missingIds.length) issues.push('missing_cited_source_ids');
  if (passageHashMismatches(passages).length) issues.push('content_hash_mismatch');
  if (passageOffsetMismatches(passages, sources).length) issues.push('quote_offset_mismatch');
  return issues;
}

export function auditStrategyRun({
  query = '',
  strategy = '',
  report = '',
  findings = [],
  sources = [],
  claims = [],
  passages = [],
  quality = {},
  trace = [],
  meta = {},
  usage = {},
} = {}) {
  const battery = matchQueryBattery(query);
  const normalizedStrategy = normalizeStrategy(strategy, { meta, trace });
  const citationMap = buildAuditCitationMap({ findings, sources, query });
  const narrativeClaims = selectNarrativeClaims(claims, report, query);
  const narrative = extractNarrativeText(report, query);
  const labeledNarrative = extractLabeledNarrative(report);
  const mergedUsage = { ...(quality?.budget?.usage || {}), ...usage };
  const cost = splitLlmCost({ usage: mergedUsage, trace });
  const reportIntegrity = auditReportIntegrity(report, query);
  const citationIntegrity = auditCitationIntegrity({
    report,
    claims: narrativeClaims,
    citationMap,
    sources,
  });
  const evidenceProvenance = auditEvidenceProvenance(sources);
  const requiredSlotCompletion = completeSlots({
    battery,
    report,
    narrative,
    claims: narrativeClaims,
    sources,
    passages,
    meta: { ...meta, query: meta.query || query },
    citationMap,
  });
  const processContract = evaluateProcessContract(normalizedStrategy, {
    battery,
    usage: mergedUsage,
    cost,
    quality,
    reportIntegrity,
    provenance: evidenceProvenance,
    slots: requiredSlotCompletion,
    labeledNarrative,
  });
  const claimChecks = narrativeClaims.map((claim) => auditClaim(claim, {
    citationMap,
    sources,
    passages,
    meta,
    sourcePolicies: battery?.sourcePolicies || {},
  }));
  const invalidReasons = structuralIssues({
    report,
    citation: citationIntegrity,
    passages,
    sources,
  });
  let status = 'ready';
  if (invalidReasons.length) status = 'invalid';
  else if (
    !processContract.pass
    || !reportIntegrity.pass
    || !citationIntegrity.pass
    || !evidenceProvenance.pass
    || !requiredSlotCompletion.pass
  ) {
    status = 'not_ready';
  }

  return {
    batteryId: battery?.id || null,
    status,
    processContract,
    reportIntegrity,
    citationIntegrity: {
      pass: citationIntegrity.pass,
      checks: citationIntegrity.checks,
      counts: citationIntegrity.counts,
    },
    evidenceProvenance,
    requiredSlotCompletion: {
      pass: requiredSlotCompletion.pass,
      slots: requiredSlotCompletion.slots,
    },
    cost: {
      explorationTokens: cost.explorationTokens,
      reportTokens: cost.reportTokens,
      evaluationTokens: cost.evaluationTokens,
      llmTokens: cost.llmTokens,
      searchRequests: cost.searchRequests,
      sourceReads: cost.sourceReads,
    },
    claimChecks,
  };
}

/** @deprecated Use auditStrategyRun. Official compare calls the auditor directly. */
export function scoreStrategyEffectiveness(input = {}) {
  return auditStrategyRun(input);
}

export {
  auditClaim,
  completeSlots,
  extractClaimNumbers,
  MIN_NARRATIVE_CHARS,
  sourceHasRealBody,
  sourceHasRealBodyOrSummary,
} from './claim-audit.mjs';
