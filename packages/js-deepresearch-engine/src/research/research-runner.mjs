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
import { buildEvidenceArtifacts, listSnippetOnlyCitationKeys } from './evidence-chain.mjs';
import { evaluatePreReport } from './quality-gates.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { createResearchProviders } from './research-providers.mjs';
import { calculateQualityMetrics, qualityGateFromClaims } from './claim-quality.mjs';
import { applyClaimEntailment } from './claim-entailment.mjs';

export class ResearchRunner {
  async run({ query, settings, signal, onProgress = () => {}, llm: providedLlm, search: providedSearch }) {
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'focused';
    const emit = createProgressEmitter(onProgress);
    const trace = [];
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
      onSearchEvent: (event) => {
        if (event?.type !== 'backend') return;
        trace.push({
          step: trace.length + 1,
          action: 'search_backend',
          reasonCode: event.status,
          query: event.query,
          backendId: event.backendId,
          engine: event.engine,
          status: event.status,
          resultCount: event.resultCount ?? 0,
          durationMs: event.durationMs ?? null,
          errorName: event.errorName || null,
          errorMessage: event.errorMessage || null,
          createdAt: new Date().toISOString(),
        });
      },
    });
    const focused = resolveFocusedSettings(settings);
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      fetch: proxiedFetch,
      onEvent: (event) => {
        trace.push({ step: trace.length + 1, action: 'rerank', reasonCode: `${event.operation}_${event.status}`, ...event, createdAt: new Date().toISOString() });
        emit({ stage: event.status === 'started' ? 'rerank_started' : (event.status === 'degraded' ? 'rerank_degraded' : 'rerank_completed'), ...event });
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
      findings = await runStrategy({ strategy, query, settings, llm, search, signal, emit, budget, queryMemory, trace, researchProviders });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      findings = [];
      trace.push({ step: trace.length + 1, action: 'research_stopped', reasonCode: 'budget_exhausted', kind: error.kind, createdAt: new Date().toISOString() });
    }

    const tracksGaps = strategy === 'exploratory' || strategy === 'focused';
    let gaps = tracksGaps ? buildGapsFromFindings(findings, query) : [];
    const preReport = evaluatePreReport({ findings, gaps, query });
    const budgetBeforeReport = budget.snapshot();
    const budgetLimitation = budgetBeforeReport.stopReason
      ? `The ${budgetBeforeReport.stopReason} budget was exhausted; remaining research actions were not scheduled.`
      : null;
    const degradedLimitation = findings.some((finding) => finding?.degraded)
      ? 'Evidence gathering was cut short before completion; treat the collected evidence as incomplete and state remaining uncertainty explicitly.'
      : null;
    const snippetOnlyKeys = listSnippetOnlyCitationKeys(findings);
    const snippetLimitation = (strategy === 'focused' || strategy === 'exploratory') && snippetOnlyKeys.length
      ? `Sources ${snippetOnlyKeys.map((key) => `[${key}]`).join(', ')} are search snippets only and cannot verify Summary or Key Findings facts. Mark those facts Unverified or move them to Caveats.`
      : null;
    const reportLimitations = [
      ...preReport.limitations,
      ...(budgetLimitation ? [budgetLimitation] : []),
      ...(degradedLimitation ? [degradedLimitation] : []),
      ...(snippetLimitation ? [snippetLimitation] : []),
    ];
    if (focused.preReportGate.blockUnsupportedClaims && preReport.gate === 'fail') {
      const error = new Error(`Research quality gate failed: ${preReport.flags.join(', ')}`);
      error.name = 'ResearchQualityError';
      throw error;
    }
    emit({ stage: 'synthesizing_report' });
    const reportSettings = resolveReportSettings(settings);
    const narrative = await buildReport({
      llm, query, findings, signal, purpose: 'report', limitations: reportLimitations, strategy,
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
    let report = assembleReport({
      narrative,
      findings,
      limitations: reportLimitations,
      query,
    });
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
    const evidenceOptions = strategy === 'exploratory'
      ? { ...focused.evidencePassages, enabled: true, claimAlignment: true }
      : focused.evidencePassages;
    if (evidenceOptions.enabled) emit({ stage: 'extracting_passages' });
    let evidence = buildEvidenceArtifacts({
      query,
      findings,
      report,
      options: { ...evidenceOptions, strategy },
    });
    findings = evidence.findings;
    gaps = tracksGaps ? buildGapsFromFindings(findings, query) : [];
    if (evidenceOptions.claimAlignment) {
      emit({ stage: 'evaluating_report' });
      trace.push({ step: trace.length + 1, action: 'evaluate_report', reasonCode: 'claim_evidence_alignment', createdAt: new Date().toISOString() });
      const entailmentMode = settings?.research?.quality?.entailment || 'rules_then_llm';
      const judgeClaims = async (current) => applyClaimEntailment(current.claims, {
        llm,
        passages: current.passages,
        signal,
        mode: entailmentMode,
      });
      evidence = { ...evidence, claims: await judgeClaims(evidence) };
      const revision = reviseUnsupportedKeyClaims(report, evidence.claims);
      if (revision.moved.length) {
        report = assembleReport({
          narrative: revision.report,
          findings,
          limitations: [
            ...reportLimitations,
            ...revision.moved.map((text) => `Insufficient direct evidence for: ${text}`),
          ],
          query,
        });
        evidence = buildEvidenceArtifacts({
          query,
          findings,
          report,
          options: { ...evidenceOptions, strategy },
        });
        findings = evidence.findings;
        evidence = { ...evidence, claims: await judgeClaims(evidence) };
      }
    }
    const qualityMetrics = calculateQualityMetrics(evidence.claims);
    const claimGate = qualityGateFromClaims(evidence.claims);
    const unverifiedKeyClaims = evidence.claims.filter((claim) => (
      claim.kind === 'key_claim' && ['unsupported', 'unverifiable'].includes(claim.evaluation?.verdict)
    ));
    const noClaims = evidenceOptions.claimAlignment && qualityMetrics.keyClaimCount === 0;
    const emptyExtraction = evidenceOptions.claimAlignment && qualityMetrics.claimCount === 0;
    const finalGate = preReport.gate === 'fail' || claimGate === 'fail' || emptyExtraction
      ? 'fail'
      : (preReport.gate === 'pass_with_warnings' || claimGate === 'pass_with_warnings' || noClaims ? 'pass_with_warnings' : 'pass');
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
        ...(budgetLimitation ? ['budget_exhausted'] : []),
        ...(noClaims ? ['no_claims'] : []),
        ...(unverifiedKeyClaims.length ? ['unverified_key_claims'] : []),
      ],
      limitations: [
        ...preReport.limitations,
        ...(budgetLimitation ? [budgetLimitation] : []),
        ...(noClaims ? ['No evaluable claims could be extracted from the report.'] : []),
        ...unverifiedKeyClaims.map((claim) => `Insufficient direct evidence for: ${claim.text}`),
      ],
      metrics: {
        ...preReport.metrics,
        ...qualityMetrics,
      },
      budget: budget.snapshot(),
    };
    emit({ stage: 'research_complete' });

    return {
      report,
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
