import { createLlmProvider } from '../llm/provider-factory.mjs';
import { createSearchEngine } from '../search/search-factory.mjs';
import { createProgressEmitter } from './progress-events.mjs';
import { buildReport } from './report-builder.mjs';
import { runStrategy } from './strategies.mjs';
import { BudgetManager, BudgetExceededError, wrapProvidersWithBudget } from './budget-manager.mjs';
import { QueryMemory } from './query-memory.mjs';
import { buildEvidenceArtifacts } from './evidence-chain.mjs';
import { evaluatePreReport } from './quality-gates.mjs';
import { resolveSourceBasedSettings } from './source-based-settings.mjs';
import { createResearchProviders } from './research-providers.mjs';
import { calculateQualityMetrics, qualityGateFromClaims } from './claim-quality.mjs';

export class ResearchRunner {
  async run({ query, settings, signal, onProgress = () => {}, llm: providedLlm, search: providedSearch }) {
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'source-based';
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
    });
    const sourceBased = resolveSourceBasedSettings(settings);
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      onEvent: (event) => {
        trace.push({ step: trace.length + 1, action: 'rerank', reasonCode: `${event.operation}_${event.status}`, ...event, createdAt: new Date().toISOString() });
        emit({ stage: event.status === 'started' ? 'rerank_started' : (event.status === 'degraded' ? 'rerank_degraded' : 'rerank_completed'), ...event });
      },
    });
    const queryMemory = new QueryMemory({
      ...sourceBased.queryMemory,
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

    const tracksGaps = strategy === 'adaptive' || strategy === 'source-based';
    let gaps = tracksGaps ? buildGapsFromFindings(findings, query) : [];
    const preReport = evaluatePreReport({ findings, gaps, query });
    const budgetBeforeReport = budget.snapshot();
    const budgetLimitation = budgetBeforeReport.stopReason
      ? `The ${budgetBeforeReport.stopReason} budget was exhausted; remaining research actions were not scheduled.`
      : null;
    const reportLimitations = [...preReport.limitations, ...(budgetLimitation ? [budgetLimitation] : [])];
    if (sourceBased.preReportGate.blockUnsupportedClaims && preReport.gate === 'fail') {
      const error = new Error(`Research quality gate failed: ${preReport.flags.join(', ')}`);
      error.name = 'ResearchQualityError';
      throw error;
    }
    emit({ stage: 'synthesizing_report' });
    let report = await buildReport({
      llm, query, findings, signal, purpose: 'report', limitations: reportLimitations,
      maxTokens: budget.limits.llmTokens > 0 ? budget.reserveReportTokens : undefined,
      minChars: settings?.research?.reportValidation?.minChars,
      maxAttempts: settings?.research?.reportValidation?.maxAttempts,
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
    const evidenceOptions = strategy === 'adaptive'
      ? { ...sourceBased.evidencePassages, enabled: true, claimAlignment: true }
      : sourceBased.evidencePassages;
    if (evidenceOptions.enabled) emit({ stage: 'extracting_passages' });
    const evidence = buildEvidenceArtifacts({ query, findings, report, options: evidenceOptions });
    findings = evidence.findings;
    gaps = tracksGaps ? buildGapsFromFindings(findings, query) : [];
    if (evidenceOptions.claimAlignment) {
      emit({ stage: 'evaluating_report' });
      trace.push({ step: trace.length + 1, action: 'evaluate_report', reasonCode: 'claim_evidence_alignment', createdAt: new Date().toISOString() });
    }
    const qualityMetrics = calculateQualityMetrics(evidence.claims);
    const claimGate = qualityGateFromClaims(evidence.claims);
    const unverifiedKeyClaims = evidence.claims.filter((claim) => claim.kind === 'key_claim' && claim.evaluation?.verdict !== 'supported');
    for (const claim of unverifiedKeyClaims) {
      report = report.replace(claim.text, `Unverified: ${claim.text}`);
    }
    if (unverifiedKeyClaims.length && !/## Evidence limitations/i.test(report)) {
      report += `\n\n## Evidence limitations\n\n${unverifiedKeyClaims.map((claim) => `- Insufficient direct evidence for: ${claim.text}`).join('\n')}`;
    }
    const noClaims = evidenceOptions.claimAlignment && evidence.claims.length === 0;
    const finalGate = preReport.gate === 'fail' || claimGate === 'fail' || noClaims
      ? 'fail'
      : (preReport.gate === 'pass_with_warnings' || claimGate === 'pass_with_warnings' ? 'pass_with_warnings' : 'pass');
    const quality = {
      schemaVersion: 3,
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
        ...(strategy === 'adaptive' ? [{ step: trace.length + 2, action: 'stop', reasonCode: budget.stopReason || 'research_sufficient', budgetAfter: budget.snapshot(), createdAt: new Date().toISOString() }] : []),
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
