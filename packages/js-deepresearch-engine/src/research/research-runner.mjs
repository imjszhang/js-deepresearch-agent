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
    const { llm, search } = wrapProvidersWithBudget({ llm: rawLlm, search: rawSearch, budget });
    const sourceBased = resolveSourceBasedSettings(settings);
    const researchProviders = createResearchProviders(settings?.research?.providers || {});
    const queryMemory = new QueryMemory({
      ...sourceBased.queryMemory,
      similarityProvider: researchProviders.similarity,
      onSkip: (event) => trace.push({ step: trace.length + 1, action: 'query_skipped_duplicate', ...event, createdAt: new Date().toISOString() }),
    });

    emit({ stage: 'research_started' });
    let findings;
    try {
      findings = await runStrategy({ strategy, query, settings, llm, search, signal, emit, budget, queryMemory, trace });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      findings = [];
      trace.push({ step: trace.length + 1, action: 'research_stopped', reasonCode: 'budget_exhausted', kind: error.kind, createdAt: new Date().toISOString() });
    }

    let gaps = strategy === 'adaptive' ? buildGapsFromFindings(findings, query) : [];
    const preReport = sourceBased.preReportGate.enabled
      ? evaluatePreReport({ findings, gaps })
      : { gate: 'pass', flags: [], criticalGaps: [], limitations: [], metrics: {} };
    if (sourceBased.preReportGate.blockUnsupportedClaims && preReport.gate === 'fail') {
      const error = new Error(`Research quality gate failed: ${preReport.flags.join(', ')}`);
      error.name = 'ResearchQualityError';
      throw error;
    }
    emit({ stage: 'synthesizing_report' });
    let report = await buildReport({
      llm, query, findings, signal, purpose: 'report', limitations: preReport.limitations,
      maxTokens: budget.limits.llmTokens > 0 ? budget.reserveReportTokens : undefined,
    });
    const evidenceOptions = strategy === 'adaptive'
      ? { ...sourceBased.evidencePassages, enabled: true, claimAlignment: true }
      : sourceBased.evidencePassages;
    if (evidenceOptions.enabled) emit({ stage: 'extracting_passages' });
    const evidence = buildEvidenceArtifacts({ query, findings, report, options: evidenceOptions });
    findings = evidence.findings;
    gaps = strategy === 'adaptive' ? buildGapsFromFindings(findings, query) : [];
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
    const finalGate = preReport.gate === 'fail' || claimGate === 'fail'
      ? 'fail'
      : (preReport.gate === 'pass_with_warnings' || claimGate === 'pass_with_warnings' ? 'pass_with_warnings' : 'pass');
    const quality = {
      schemaVersion: 3,
      qualityMetricsVersion: qualityMetrics.metricsVersion,
      claimExtractionVersion: qualityMetrics.claimExtractionVersion,
      claimEvaluationVersion: qualityMetrics.claimEvaluationVersion,
      ...preReport,
      gate: finalGate,
      flags: [...preReport.flags, ...(unverifiedKeyClaims.length ? ['unverified_key_claims'] : [])],
      limitations: [...preReport.limitations, ...unverifiedKeyClaims.map((claim) => `Insufficient direct evidence for: ${claim.text}`)],
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
  return findings.map((finding, index) => ({
    id: finding.gapId || `gap-${index + 1}`,
    question: finding.question || query,
    parentId: index === 0 ? null : 'gap-1',
    depth: index === 0 ? 0 : 1,
    status: (finding.sources || []).length ? 'resolved' : 'deferred',
    priority: index === 0 ? 'critical' : 'normal',
    reason: (finding.sources || []).length ? 'Usable sources found.' : 'No usable sources found.',
    findingIds: finding.id ? [finding.id] : [],
    createdAtStep: 1,
    resolvedAtStep: (finding.sources || []).length ? index + 1 : null,
  }));
}
