import { createLlmProvider } from '../llm/provider-factory.mjs';
import { createSearchEngine } from '../search/search-factory.mjs';
import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { createProgressEmitter } from './progress-events.mjs';
import { buildReport, ReportGenerationError, validateReportOutput } from './report-builder.mjs';
import { assembleReport, reviseUnsupportedKeyClaims } from './report-assembler.mjs';
import { resolveReportSettings } from './report-settings.mjs';
import { runStrategy } from './strategies.mjs';
import { BudgetManager, BudgetExceededError, wrapProvidersWithBudget } from './budget-manager.mjs';
import { QueryMemory } from './query-memory.mjs';
import { alignReportClaims, buildPassageArtifactsAsync, listSnippetOnlyCitationKeys } from './evidence-chain.mjs';
import { evaluatePreReport } from './quality-gates.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { createResearchProviders } from './research-providers.mjs';
import { calculateQualityMetrics, qualityGateFromClaims } from './claim-quality.mjs';
import { applyClaimEntailment } from './claim-entailment.mjs';
import { researchBriefFromInput } from './research-brief.mjs';
import { collectGapSources, evaluateGapEvidence, rollupRootGap } from './gap-state.mjs';

export class ResearchRunner {
  async run({ query, settings, signal, onProgress = () => {}, llm: providedLlm, search: providedSearch }) {
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'focused';
    const queryWasStructured = typeof query === 'object' && query !== null;
    const brief = researchBriefFromInput(query, { depth: strategy });
    query = brief.query;
    const emit = createProgressEmitter(onProgress);
    const trace = [];
    trace.push({
      step: 1,
      action: 'research_brief',
      reasonCode: queryWasStructured ? 'structured_input' : 'query_compatibility_input',
      brief,
      createdAt: new Date().toISOString(),
    });
    const budget = new BudgetManager(settings, emit);
    const { llm, search } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      onLlmEvent: (event) => {
        trace.push({
          step: trace.length + 1,
          action: 'llm_call',
          reasonCode: event.purpose,
          ...event,
          createdAt: new Date().toISOString(),
        });
        emit({ stage: event.status === 'started' ? 'llm_call_started' : 'llm_call_finished', ...event });
      },
    });
    const focused = resolveFocusedSettings(settings);
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      fetch: proxiedFetch,
      onEvent: (event) => {
        const action = event.operation === 'embed' ? 'embed' : 'rerank';
        trace.push({ step: trace.length + 1, action, reasonCode: `${event.operation}_${event.status}`, ...event, createdAt: new Date().toISOString() });
        const stage = event.operation === 'embed'
          ? (event.status === 'started' ? 'embed_started' : (event.status === 'degraded' ? 'embed_degraded' : 'embed_completed'))
          : (event.status === 'started' ? 'rerank_started' : (event.status === 'degraded' ? 'rerank_degraded' : 'rerank_completed'));
        emit({ stage, ...event });
      },
    });
    const queryMemory = new QueryMemory({
      ...focused.queryMemory,
      similarityProvider: researchProviders.similarity,
      onSkip: (event) => trace.push({ step: trace.length + 1, action: 'query_skipped_duplicate', ...event, createdAt: new Date().toISOString() }),
    });

    emit({ stage: 'research_started' });
    let findings;
    try {
      findings = await runStrategy({ strategy, query, brief, settings, llm, search, signal, emit, budget, queryMemory, trace, researchProviders });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      findings = [];
      trace.push({ step: trace.length + 1, action: 'research_stopped', reasonCode: 'budget_exhausted', kind: error.kind, createdAt: new Date().toISOString() });
    }

    const tracksGaps = strategy === 'exploratory' || strategy === 'focused';
    const exploratoryLoop = findings?.exploratoryLoop || null;
    const focusedControl = findings?.researchControl || null;
    const resolvedBrief = findings?.researchBrief || exploratoryLoop?.brief || brief;
    let gaps = exploratoryLoop?.gaps?.length
      ? exploratoryLoop.gaps
      : (focusedControl?.gaps?.length
        ? focusedControl.gaps
        : (tracksGaps ? buildGapsFromFindings(findings, query) : []));
    const preReport = evaluatePreReport({ findings, gaps, query });
    const budgetBeforeReport = budget.snapshot();
    const budgetLimitation = budgetBeforeReport.stopReason
      ? `The ${budgetBeforeReport.stopReason} budget was exhausted; remaining research actions were not scheduled.`
      : null;
    const unresolvedLimitation = exploratoryLoop?.unresolvedGaps?.length
      ? `Unresolved gaps: ${exploratoryLoop.unresolvedGaps.map((gap) => `${gap.id} (${gap.status}) ${gap.question}`).join('; ')}`
      : null;
    const blockedHostLimitation = exploratoryLoop?.blockedHosts?.length
      ? `Blocked or unread required hosts: ${exploratoryLoop.blockedHosts.join(', ')}.`
      : null;
    const secondaryLimitation = exploratoryLoop?.secondaryOnlyClaims?.length
      ? 'Some conclusions rest only on secondary or reprint sources and cannot be treated as primary-source verified.'
      : null;
    const focusedFailures = focusedControl?.readiness?.failures || [];
    const unsupportedLimitation = exploratoryLoop?.unsupportedDecisions?.length
      ? `The report cannot support: ${exploratoryLoop.unsupportedDecisions.join('; ')}`
      : (focusedFailures.length
        ? `The report cannot support: ${focusedFailures.map((failure) => failure.message).join('; ')}`
        : null);
    const degradedLimitation = findings.some((finding) => finding?.degraded)
      ? 'Evidence gathering was cut short before completion; treat the collected evidence as incomplete and state remaining uncertainty explicitly.'
      : null;
    const snippetOnlyKeys = listSnippetOnlyCitationKeys(findings);
    const snippetLimitation = (strategy === 'focused' || strategy === 'exploratory') && snippetOnlyKeys.length
      ? `Sources ${snippetOnlyKeys.map((key) => `[${key}]`).join(', ')} are search snippets only and cannot verify Summary or Key Findings facts. Mark those facts Unverified or move them to Caveats.`
      : null;
    const earlyContractUnavailable = Boolean(
      focusedControl?.contractUnavailable
      || focusedControl?.profile?.contractUnavailable
      || exploratoryLoop?.profile?.contractUnavailable,
    );
    const contractLimitation = earlyContractUnavailable
      ? 'The research contract could not be planned; required slots were not available to verify.'
      : null;
    const reportLimitations = [
      ...preReport.limitations,
      ...(budgetLimitation ? [budgetLimitation] : []),
      ...(contractLimitation ? [contractLimitation] : []),
      ...(degradedLimitation ? [degradedLimitation] : []),
      ...(snippetLimitation ? [snippetLimitation] : []),
      ...(unresolvedLimitation ? [unresolvedLimitation] : []),
      ...(blockedHostLimitation ? [blockedHostLimitation] : []),
      ...(secondaryLimitation ? [secondaryLimitation] : []),
      ...(unsupportedLimitation ? [unsupportedLimitation] : []),
    ];
    if (focused.preReportGate.blockUnsupportedClaims && preReport.gate === 'fail') {
      const error = new Error(`Research quality gate failed: ${preReport.flags.join(', ')}`);
      error.name = 'ResearchQualityError';
      throw error;
    }
    emit({ stage: 'synthesizing_report' });
    const reportSettings = resolveReportSettings(settings);
    const evidenceOptions = strategy === 'exploratory'
      ? { ...focused.evidencePassages, enabled: true, claimAlignment: true }
      : focused.evidencePassages;
    if (evidenceOptions.enabled) emit({ stage: 'extracting_passages' });
    const passageArtifacts = await buildPassageArtifactsAsync({
      query,
      findings,
      options: {
        ...evidenceOptions,
        strategy,
        embedding: researchProviders.embedding,
        signal,
      },
    });
    findings = passageArtifacts.findings;
    if (!exploratoryLoop?.gaps?.length && !focusedControl?.gaps?.length) {
      gaps = tracksGaps ? buildGapsFromFindings(findings, query) : [];
    }
    if (tracksGaps) {
      gaps = gaps.map((gap) => evaluateGapEvidence(
        gap,
        collectGapSources(gap, findings),
        {
          passageIds: findings
            .filter((finding) => finding.gapId === gap.id)
            .flatMap((finding) => finding.passageIds || []),
          passages: passageArtifacts.passages,
          slotSupport: gap.slotSupport,
        },
      ));
      rollupRootGap(gaps);
    }
    let narrativeDraft = await buildReport({
      llm, query, findings, signal, purpose: 'report', limitations: reportLimitations, strategy,
      passages: passageArtifacts.passages,
      maxPassageChars: evidenceOptions.maxPassageChars,
      maxTokens: reportSettings.maxOutputTokens,
      minChars: reportSettings.minChars,
      maxAttempts: reportSettings.maxAttempts,
      mode: 'narrative',
      onAttempt: (event) => {
        trace.push({
          step: trace.length + 1,
          action: event.status === 'invalid' ? 'report_retry_requested' : 'draft',
          reasonCode: event.status === 'invalid' ? event.flags?.[0] : `report_attempt_${event.status}`,
          ...event,
          createdAt: new Date().toISOString(),
        });
        if (event.status === 'invalid') emit({ stage: 'report_retrying', ...event });
      },
    });
    const assembleCurrentReport = (limitations = reportLimitations) => assembleReport({
      narrative: narrativeDraft,
      findings,
      passages: passageArtifacts.passages,
      maxPassageChars: evidenceOptions.maxPassageChars,
      limitations,
      query,
    });
    let report = assembleCurrentReport();
    const assembledCheck = validateReportOutput(report, {
      minChars: reportSettings.minChars,
      mode: 'full',
      findings,
    });
    if (!assembledCheck.ok && findings.length > 0) {
      throw new ReportGenerationError({
        attempts: reportSettings.maxAttempts,
        minChars: reportSettings.minChars,
        outputChars: assembledCheck.outputChars,
        flags: assembledCheck.flags,
      });
    }
    let claims = [];
    let movedClaimTexts = [];
    if (evidenceOptions.claimAlignment) {
      emit({ stage: 'evaluating_report' });
      trace.push({ step: trace.length + 1, action: 'evaluate_report', reasonCode: 'claim_evidence_alignment', createdAt: new Date().toISOString() });
      const entailmentMode = settings?.research?.quality?.entailment || 'rules_then_llm';
      const judgeClaims = async (currentClaims) => applyClaimEntailment(currentClaims, {
        llm,
        passages: passageArtifacts.passages,
        signal,
        mode: entailmentMode,
      });
      const alignCurrentReport = () => alignReportClaims({
        report,
        passages: passageArtifacts.passages,
        citationMap: passageArtifacts.citationMap,
        options: { ...evidenceOptions, strategy },
      });
      claims = await judgeClaims(alignCurrentReport());
      const revision = reviseUnsupportedKeyClaims(narrativeDraft, claims);
      movedClaimTexts = revision.moved;
      if (revision.moved.length) {
        narrativeDraft = revision.report;
        report = assembleCurrentReport([
          ...reportLimitations,
          ...revision.moved.map((text) => `Insufficient direct evidence for: ${text}`),
        ]);
        claims = await judgeClaims(alignCurrentReport());
      }
      const revisedCheck = validateReportOutput(report, {
        minChars: reportSettings.minChars,
        mode: 'full',
        findings,
      });
      if (!revisedCheck.ok && findings.length > 0) {
        throw new ReportGenerationError({
          attempts: reportSettings.maxAttempts,
          minChars: reportSettings.minChars,
          outputChars: revisedCheck.outputChars,
          flags: revisedCheck.flags,
        });
      }
    }
    const evidence = {
      findings,
      sources: passageArtifacts.sources,
      passages: passageArtifacts.passages,
      claims,
      citationMap: passageArtifacts.citationMap,
    };
    const qualityMetrics = calculateQualityMetrics(evidence.claims);
    const claimGate = qualityGateFromClaims(evidence.claims);
    const unverifiedKeyClaims = evidence.claims.filter((claim) => (
      claim.kind === 'key_claim' && ['unsupported', 'unverifiable'].includes(claim.evaluation?.verdict)
    ));
    const movedClaimSet = new Set(movedClaimTexts);
    const noClaims = evidenceOptions.claimAlignment && qualityMetrics.keyClaimCount === 0;
    const emptyExtraction = evidenceOptions.claimAlignment && qualityMetrics.claimCount === 0;
    const finalGate = preReport.gate === 'fail' || claimGate === 'fail' || emptyExtraction
      ? 'fail'
      : (preReport.gate === 'pass_with_warnings' || claimGate === 'pass_with_warnings' || noClaims ? 'pass_with_warnings' : 'pass');
    const controlProfile = focusedControl?.profile || exploratoryLoop?.profile || {};
    const contractUnavailable = Boolean(
      controlProfile.contractUnavailable || focusedControl?.contractUnavailable,
    );
    const slotSupportUnknown = gaps.some((gap) => (
      gap?.slotSupport?.method === 'fail_closed' || gap?.slotSupport?.verdict === 'unverifiable'
    ));
    const quality = {
      schemaVersion: 3,
      stopReason: budget.controllerStopReason || null,
      qualityMetricsVersion: qualityMetrics.metricsVersion,
      claimExtractionVersion: qualityMetrics.claimExtractionVersion,
      claimEvaluationVersion: qualityMetrics.claimEvaluationVersion,
      ...preReport,
      gate: finalGate,
      flags: [
        ...preReport.flags,
        ...focusedFailures.map((failure) => failure.code).filter(Boolean),
        ...(budgetLimitation ? ['budget_exhausted'] : []),
        ...(controlProfile.contractRetried ? ['contract_plan_retried'] : []),
        ...(contractUnavailable ? ['contract_unavailable'] : []),
        ...(slotSupportUnknown ? ['slot_support_unknown'] : []),
        ...(noClaims ? ['no_claims'] : []),
        ...(unverifiedKeyClaims.length ? ['unverified_key_claims'] : []),
      ],
      limitations: [
        ...preReport.limitations,
      ...(budgetLimitation ? [budgetLimitation] : []),
      ...(contractLimitation ? [contractLimitation] : []),
      ...(unresolvedLimitation ? [unresolvedLimitation] : []),
        ...(blockedHostLimitation ? [blockedHostLimitation] : []),
        ...(secondaryLimitation ? [secondaryLimitation] : []),
        ...(unsupportedLimitation ? [unsupportedLimitation] : []),
        ...(noClaims ? ['No evaluable claims could be extracted from the report.'] : []),
        ...(evidenceOptions.claimAlignment
          ? unverifiedKeyClaims.filter((claim) => movedClaimSet.has(claim.text))
          : unverifiedKeyClaims
        ).map((claim) => `Insufficient direct evidence for: ${claim.text}`),
      ],
      metrics: {
        ...preReport.metrics,
        ...qualityMetrics,
        marginal: focusedControl?.marginal || exploratoryLoop?.marginal || null,
      },
      budget: budget.snapshot(),
    };
    emit({ stage: 'research_complete' });

    return {
      report,
      brief: resolvedBrief,
      findings,
      sources: evidence.sources,
      gaps,
      passages: evidence.passages,
      claims: evidence.claims,
      quality,
      trace: [
        ...trace,
        { step: trace.length + 1, action: 'finalize', reasonCode: 'completed', budgetAfter: budget.snapshot(), createdAt: new Date().toISOString() },
        ...(strategy === 'exploratory' ? [{ step: trace.length + 2, action: 'stop', reasonCode: budget.controllerStopReason || budget.stopReason || 'research_sufficient', budgetAfter: budget.snapshot(), createdAt: new Date().toISOString() }] : []),
      ],
    };
  }
}

function buildGapsFromFindings(findings, query) {
  const gaps = new Map();
  for (const [index, finding] of findings.entries()) {
    const question = String(finding.question || query).trim();
    const key = question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    const resolved = (finding.sources || []).length > 0;
    const existing = gaps.get(key);
    if (existing) {
      if (finding.id && !existing.findingIds.includes(finding.id)) existing.findingIds.push(finding.id);
      if (resolved) {
        existing.status = 'resolved';
        existing.reason = 'Usable sources found.';
        existing.resolvedAtStep ??= index + 1;
      }
      continue;
    }
    const gapIndex = gaps.size;
    gaps.set(key, {
      id: finding.gapId || `gap-${gapIndex + 1}`,
      question,
      parentId: gapIndex === 0 ? null : 'gap-1',
      depth: gapIndex === 0 ? 0 : 1,
      status: resolved ? 'resolved' : 'open',
      priority: gapIndex === 0 || question === query ? 'critical' : 'normal',
      reason: resolved ? 'Usable sources found.' : 'No usable sources found.',
      findingIds: finding.id ? [finding.id] : [],
      createdAtStep: 1,
      resolvedAtStep: resolved ? index + 1 : null,
    });
  }
  return [...gaps.values()];
}
