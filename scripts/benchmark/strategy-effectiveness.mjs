import { mapHistoricalStrategy, parseCitations, sourceHasFetchedBody, sourceUsableForAsOf } from 'js-deepresearch-engine';
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
  const budget = quality.budget || {};
  const usage = budget.usage || {};
  const limits = budget.limits || {};
  const effectiveUsage = {
    ...usage,
    explorationTokens: Number(usage.explorationTokens ?? usage.llmTokens) || 0,
  };
  const exhausted = [
    ['explorationTokens', 'llmTokens'],
    ['llmTokens', 'totalLlmTokens'],
    ['searchRequests', 'searchRequests'],
    ['sourceReads', 'sourceReads'],
  ].some(([usageKey, limitKey]) => {
    const limit = Number(limits[limitKey]) || 0;
    return limit > 0 && Number(effectiveUsage[usageKey] || 0) >= limit;
  });
  if (exhausted) return true;
  const requiredAmount = Number(budget.controllerStopRequiredAmount) || 0;
  if (quality.stopReason === 'budget_exhausted'
    && budget.controllerStopDetail === 'llm_hard_cap'
    && Number(limits.llmTokens) > 0
    && requiredAmount > 0
    && effectiveUsage.explorationTokens + requiredAmount > Number(limits.llmTokens)) return true;
  return quality.stopReason === 'safety_cap'
    || quality.stopReason === 'user_cancelled'
    || quality.stopDetail === 'max_steps';
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

export function auditQueryProvenance(trace = [], quality = {}) {
  const searches = (Array.isArray(trace) ? trace : []).filter((entry) => (
    entry?.action === 'search' && !['rejected', 'skipped'].includes(entry.status)
  ));
  const hasSchema = searches.some((entry) => entry.queryOrigin)
    || Boolean(quality?.metrics?.queryProvenance)
    || Number(quality?.metrics?.recovery?.plannerRetryCount) > 0
    || Number(quality?.metrics?.recovery?.plannerRejectedQueries) > 0;
  if (!hasSchema) {
    return {
      pass: true,
      applicable: false,
      checks: [check('query_provenance', true, 'Legacy run has no query provenance schema.')],
      counts: { missing: 0, ruleGenerated: 0, siteFallbackWithoutPlanner: 0, legacy: true },
    };
  }
  const missing = searches.filter((entry) => !entry.queryOrigin);
  const illegalOrigin = searches.filter((entry) => (
    entry.queryOrigin && !['user_query', 'llm_planner'].includes(entry.queryOrigin)
  ));
  const ruleTemplates = searches.filter((entry) => (
    /primary source evidence|conflicting evidence correction|counterexample failure/i.test(
      String(entry.query || (entry.queries || []).join(' ')),
    )
  ));
  const siteFallbackWithoutPlanner = searches.filter((entry) => (
    (entry.reasonCode === 'site_fallback_query' || entry.siteFallbackOf)
    && entry.queryOrigin !== 'llm_planner'
  ));
  const checks = [
    check(
      'query_provenance_complete',
      missing.length === 0,
      missing.length ? `${missing.length} search(es) lack queryOrigin.` : 'Every executed search has queryOrigin.',
    ),
    check(
      'query_origin_allowed',
      illegalOrigin.length === 0 && ruleTemplates.length === 0,
      illegalOrigin.length || ruleTemplates.length
        ? 'Rule-generated or illegal query origins were executed.'
        : 'Executed search origins are user_query or llm_planner.',
    ),
    check(
      'site_fallback_via_planner',
      siteFallbackWithoutPlanner.length === 0,
      siteFallbackWithoutPlanner.length
        ? `${siteFallbackWithoutPlanner.length} site fallback search(es) were not planner-authored.`
        : 'Site fallback searches are planner-authored.',
    ),
  ];
  return {
    pass: checks.every((item) => item.pass),
    applicable: true,
    checks,
    counts: {
      missing: missing.length,
      ruleGenerated: illegalOrigin.length + ruleTemplates.length,
      siteFallbackWithoutPlanner: siteFallbackWithoutPlanner.length,
      legacy: false,
    },
  };
}

export function auditRelevanceIntegrity(sources = [], quality = {}) {
  const records = Array.isArray(sources) ? sources : [];
  const acceptedRejected = records.filter((source) => (
    source?.relevanceDecision?.accepted === false
    && ['ok', 'read'].includes(source.fetchStatus || source.bodyQuality)
  ));
  const funnel = quality?.metrics?.relevance || null;
  const siteBalanced = !funnel || Number(funnel.returnedCandidates || 0)
    === Number(funnel.siteRejected || 0) + Number(funnel.admittedCandidates || 0);
  const rerankBalanced = !funnel || Number(funnel.rerankEvaluated || 0)
    === Number(funnel.rerankAccepted || 0) + Number(funnel.rerankRejected || 0);
  const decisions = records.flatMap((source) => [
    source?.relevanceDecision,
    ...Object.values(source?.relevanceDecisionByGap || {}),
    ...Object.values(source?.gapMatches || {}).map((match) => match?.relevanceDecision),
  ]).filter(Boolean);
  const unevaluatedRerankRejections = decisions.filter((decision) => (
    decision.reasonCode === 'rerank_below_threshold' && decision.rerankScore == null
  ));
  const checks = [
    check(
      'no_rejected_source_as_body',
      acceptedRejected.length === 0,
      acceptedRejected.length
        ? `${acceptedRejected.length} relevance-rejected source(s) were counted as body evidence.`
        : 'No relevance-rejected source is counted as body evidence.',
    ),
    check('site_funnel_balanced', siteBalanced, siteBalanced ? 'Site relevance funnel balances.' : 'Site relevance funnel does not balance.'),
    check('rerank_funnel_balanced', rerankBalanced, rerankBalanced ? 'Rerank relevance funnel balances.' : 'Rerank relevance funnel does not balance.'),
    check(
      'no_unevaluated_rerank_rejection',
      unevaluatedRerankRejections.length === 0,
      unevaluatedRerankRejections.length
        ? `${unevaluatedRerankRejections.length} unevaluated rerank decision(s) were rejected.`
        : 'No unevaluated rerank decision was rejected.',
    ),
  ];
  return {
    pass: checks.every((item) => item.pass),
    checks,
    counts: {
      rejectedSourceBodies: acceptedRejected.length,
      legacy: !funnel,
      unevaluatedRerankRejections: unevaluatedRerankRejections.length,
    },
  };
}

export function auditAsOfCompliance(brief = {}, claims = [], sources = [], passages = []) {
  const asOf = brief?.asOf;
  if (!asOf?.date) {
    return {
      applicable: false,
      pass: true,
      reason: 'not_applicable',
      checks: [check('as_of_present', true, 'No explicit asOf contract on this brief.')],
    };
  }
  const sourceById = new Map((sources || []).map((source) => [source.id || source.url, source]));
  const keyClaims = (claims || []).filter((claim) => claim.kind === 'key_claim');
  const failures = [];
  for (const claim of keyClaims) {
    const citedIds = claim.citedSourceIds || [];
    if (!citedIds.length) continue;
    const cited = citedIds.map((id) => sourceById.get(id)).filter(Boolean);
    const citedPassages = (passages || []).filter((passage) => citedIds.includes(passage.sourceId));
    const usable = cited.some((source) => {
      const text = citedPassages
        .filter((passage) => passage.sourceId === (source.id || source.url))
        .map((passage) => passage.text)
        .join('\n');
      return sourceUsableForAsOf(source, asOf, { passageText: text }).usable;
    });
    if (!usable) failures.push(claim.text);
  }
  return {
    applicable: true,
    pass: failures.length === 0,
    reason: failures.length ? 'post_cutoff_or_unknown_date' : 'within_cutoff',
    checks: [check(
      'as_of_key_claims',
      failures.length === 0,
      failures.length
        ? `${failures.length} key claim(s) used post-cutoff or undated sources.`
        : 'Key claims respect the explicit asOf cutoff.',
    )],
  };
}

export function evaluateProcessContract(strategy, {
  usage = {},
  cost = {},
  quality = {},
  reportIntegrity,
  provenance,
  slots,
  contractMaterialization = { pass: true },
  labeledNarrative = '',
  report = '',
  trace = [],
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
    checks.push(check(
      'contract_slot_materialization',
      contractMaterialization.pass,
      contractMaterialization.pass ? 'Brief slots map one-to-one to gaps.' : 'Brief/gap slot mapping is incomplete or ambiguous.',
    ));
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
      'contract_slot_materialization',
      contractMaterialization.pass,
      contractMaterialization.pass ? 'Brief slots map one-to-one to gaps.' : 'Brief/gap slot mapping is incomplete or ambiguous.',
    ));
    const claimedBudgetStop = quality.stopReason === 'budget_exhausted'
      || quality.budget?.controllerStopReason === 'budget_exhausted';
    checks.push(check(
      'no_false_budget_exhaustion',
      !claimedBudgetStop || hasHardStop(quality),
      claimedBudgetStop && !hasHardStop(quality)
        ? 'false_budget_exhaustion: no recorded finite cap was reached.'
        : 'Budget stop is backed by a reached finite cap.',
    ));
    checks.push(check(
      'exploration_token_floor_or_hard_stop',
      minTokens === 0 || explorationTokens >= minTokens || hasHardStop(quality),
      minTokens
        ? `explorationTokens=${explorationTokens}, min=${minTokens}, hardStop=${hasHardStop(quality)}.`
        : 'No exploration token floor recorded.',
    ));
    const successfulEvidenceEntries = trace.filter((entry) => (
      (entry.action === 'read' && Number(entry.successfulBodies) > 0)
      || (entry.action === 'search' && (Number(entry.newUrlCount) > 0 || Number(entry.resultCount) > 0))
    ));
    const lastEvidenceTokens = successfulEvidenceEntries.length
      ? Number(successfulEvidenceEntries.at(-1)?.budgetAfter?.usage?.llmTokens) || 0
      : 0;
    const zeroEvidenceTailTokens = explorationTokens == null
      ? null
      : Math.max(0, Number(explorationTokens) - lastEvidenceTokens);
    const tailRatio = explorationTokens > 0 && zeroEvidenceTailTokens != null
      ? zeroEvidenceTailTokens / explorationTokens
      : 0;
    const tailObservable = trace.some((entry) => Number.isFinite(Number(entry?.budgetAfter?.usage?.llmTokens)));
    checks.push(check(
      'no_zero_evidence_spin',
      !tailObservable || tailRatio <= 0.25,
      tailObservable
        ? `zeroEvidenceTailTokens=${zeroEvidenceTailTokens ?? 'n/a'}, explorationTokens=${explorationTokens ?? 'n/a'}, ratio=${tailRatio.toFixed(3)}.`
        : 'Zero-evidence tail is not observable in this legacy trace.',
    ));
    const blockedGaps = quality?.metrics?.recovery?.blockedGaps || [];
    const limitationText = String(report || '').split(/^##?\s+(?:Limitations|Caveats)\b/im).slice(1).join('\n');
    const disclosed = blockedGaps.every((gap) => (
      limitationText.includes(String(gap.answerSlot || gap.gapId))
      && limitationText.includes(String(gap.blockedReason || 'repair_exhausted'))
    ));
    checks.push(check(
      'blocked_slots_disclosed',
      disclosed,
      blockedGaps.length
        ? `${blockedGaps.length} blocked slot(s) ${disclosed ? 'are' : 'are not'} disclosed in Limitations/Caveats.`
        : 'No blocked slots require disclosure.',
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

  const queryProvenance = auditQueryProvenance(trace, quality);
  if (queryProvenance.applicable) {
    checks.push(...queryProvenance.checks);
  } else {
    checks.push(check('query_provenance', true, 'Legacy run has no query provenance schema.'));
  }

  return {
    pass: checks.length > 0 && checks.every((item) => item.pass),
    checks,
  };
}

export function auditContractMaterialization(brief = {}, gaps = []) {
  const expected = brief?.requiredAnswerSlots || [];
  if (!expected.length) return { pass: true, missing: [], duplicates: [], orphan: [] };
  const requiredGaps = (gaps || []).filter((gap) => gap?.requiredSlot && !gap?.rollup);
  const matchesFor = (slot) => requiredGaps.filter((gap) => (
    gap.contractSlotId === slot.id
    || (!gap.contractSlotId && gap.answerSlot === slot.answerSlot)
  ));
  const missing = expected.filter((slot) => matchesFor(slot).length === 0).map((slot) => slot.id);
  const duplicates = expected.filter((slot) => matchesFor(slot).length > 1).map((slot) => slot.id);
  const expectedIds = new Set(expected.map((slot) => slot.id));
  const expectedAnswers = new Set(expected.map((slot) => slot.answerSlot));
  const orphan = requiredGaps
    .filter((gap) => (
      gap.contractSlotId ? !expectedIds.has(gap.contractSlotId) : !expectedAnswers.has(gap.answerSlot)
    ))
    .map((gap) => gap.id);
  return { pass: !missing.length && !duplicates.length && !orphan.length, missing, duplicates, orphan };
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
  gaps = [],
  brief = {},
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
  const relevanceIntegrity = auditRelevanceIntegrity(sources, quality);
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
  const asOfCompliance = auditAsOfCompliance(brief, narrativeClaims, sources, passages);
  const contractMaterialization = auditContractMaterialization(brief, gaps);
  const processContract = evaluateProcessContract(normalizedStrategy, {
    battery,
    usage: mergedUsage,
    cost,
    quality,
    reportIntegrity,
    provenance: evidenceProvenance,
    slots: requiredSlotCompletion,
    contractMaterialization,
    labeledNarrative,
    report,
    trace,
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
  const allSlots = requiredSlotCompletion.slots || [];
  const requiredOnly = allSlots.filter((slot) => slot.required);
  const slotCounts = {
    total: allSlots.length,
    completed: allSlots.filter((slot) => slot.status === 'completed').length,
    required: requiredOnly.length,
    requiredCompleted: requiredOnly.filter((slot) => slot.status === 'completed').length,
  };
  let status = 'ready';
  if (invalidReasons.length) status = 'invalid';
  else if (
    !processContract.pass
    || !reportIntegrity.pass
    || !citationIntegrity.pass
    || !evidenceProvenance.pass
    || !relevanceIntegrity.pass
    || !requiredSlotCompletion.pass
    || !asOfCompliance.pass
  ) {
    status = 'not_ready';
  }

  return {
    batteryId: battery?.id || null,
    status,
    invalidReasons,
    slotCounts,
    processContract,
    reportIntegrity,
    citationIntegrity: {
      pass: citationIntegrity.pass,
      checks: citationIntegrity.checks,
      counts: citationIntegrity.counts,
    },
    evidenceProvenance,
    relevanceIntegrity,
    requiredSlotCompletion: {
      pass: requiredSlotCompletion.pass,
      slots: requiredSlotCompletion.slots,
      counts: slotCounts,
    },
    asOfCompliance,
    contractMaterialization,
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
