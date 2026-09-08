import { resolveReportSettings } from './report-settings.mjs';
import { buildPassageArtifactsAsync, listSnippetOnlyCitationKeys } from './evidence-chain.mjs';
import { evaluatePreReport } from './quality-gates.mjs';
import { archiveDisclosureText } from './alternate-evidence.mjs';
import { plannerFactsFromSnapshot } from './transport-memory.mjs';
import { collectManualImportHints } from './manual-import.mjs';
import { buildResearchLimitations } from './limitations.mjs';
import { collectGapSources, evaluateGapEvidence, rollupRootGap } from './gap-state.mjs';
import { buildReportContract } from './report-contract.mjs';
import { buildReportPlan } from './report-plan.mjs';
import { finalizePreparedReport } from './report-finalizer.mjs';
import { EvidenceStore } from './evidence-store.mjs';

export async function continueAfterStrategy({
  findings,
  strategy,
  query,
  brief,
  settings,
  llm,
  signal,
  emit,
  recorder,
  budget,
  queryMemory,
  researchProviders,
  focused,
  trace,
}) {
    const tracksGaps = strategy === 'exploratory' || strategy === 'focused';
    const exploratoryLoop = findings?.exploratoryLoop || null;
    const focusedControl = findings?.researchControl || null;
    const resolvedBrief = findings?.researchBrief || exploratoryLoop?.brief || brief;
    const storedEvidence = exploratoryLoop?.evidenceStore || focusedControl?.evidenceStore;
    const evidenceStore = resolvedBrief?.executionVersion === 2 ? new EvidenceStore(storedEvidence || null) : null;
    let gaps = exploratoryLoop?.gaps?.length
      ? exploratoryLoop.gaps
      : (focusedControl?.gaps?.length
        ? focusedControl.gaps
        : (tracksGaps ? buildGapsFromFindings(findings, query) : []));
    const budgetBeforeReport = budget.snapshot();
    recorder.checkpoint('strategy-complete', {
      strategy,
      query,
      brief: resolvedBrief,
      findings,
      gaps,
      control: exploratoryLoop || focusedControl || null,
      budget: budget.exportCheckpoint(),
      queryMemory: queryMemory.exportCheckpoint(),
      trace,
    });
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
        evidenceStore,
      },
    });
    findings = passageArtifacts.findings;
    recorder.checkpoint('passages-extracted', {
      strategy,
      query,
      brief: resolvedBrief,
      findings,
      gaps,
      passages: passageArtifacts.passages,
      evidenceStore: passageArtifacts.evidenceStore || null,
      sources: passageArtifacts.sources,
      citationMap: [...passageArtifacts.citationMap.entries()],
      budget: budget.exportCheckpoint(),
      queryMemory: queryMemory.exportCheckpoint(),
      trace,
    });
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
          entities: resolvedBrief?.entities || [],
          entityAliases: resolvedBrief?.entityAliases || [],
          query,
          brief: resolvedBrief,
        },
      ));
      rollupRootGap(gaps);
    }
    const preReport = evaluatePreReport({ findings, gaps, query });
    if (focused.preReportGate.blockUnsupportedClaims && preReport.gate === 'fail') {
      const error = new Error(`Research quality gate failed: ${preReport.flags.join(', ')}`);
      error.name = 'ResearchQualityError';
      throw error;
    }
    const controlProfile = focusedControl?.profile || exploratoryLoop?.profile || {};
    const contractUnavailable = Boolean(
      controlProfile.contractUnavailable
      || focusedControl?.contractUnavailable
      || exploratoryLoop?.profile?.contractUnavailable,
    );
    const readiness = exploratoryLoop?.readiness || focusedControl?.readiness || null;
    const focusedFailures = focusedControl?.readiness?.failures || [];
    const snippetOnlyKeys = listSnippetOnlyCitationKeys(findings);
    const stopReason = budget.controllerStopReason || exploratoryLoop?.stopReason || null;
    const stopDetail = budget.controllerStopDetail || exploratoryLoop?.stopDetail || null;
    const materialBlockedSlots = (exploratoryLoop?.recovery?.blockedGaps || []).filter((entry) => {
      const gap = gaps.find((item) => item.id === entry.gapId);
      return gap && !gap.rollup;
    });
    const limitationBase = {
      gaps,
      readiness,
      stopReason,
      stopDetail,
      budget: budgetBeforeReport,
      findings,
      strategy,
      brief: resolvedBrief,
      snippetOnlyKeys,
      contractUnavailable,
      secondaryOnly: Boolean(exploratoryLoop?.secondaryOnlyClaims?.length),
      reprintOnly: findings.flatMap((finding) => finding.sources || []).some((source) => (
        source.evidenceTier === 'reprint'
        || source.retrievedVia === 'archive'
        || source.retrievedVia === 'google_cache'
        || source.tier === 'reprint'
      )),
      blockedHosts: plannerFactsFromSnapshot(exploratoryLoop?.transportMemory || focusedControl?.transportMemory || {}).blockedHosts,
      unmetRequiredHosts: (readiness?.failures || [])
        .filter((failure) => failure.code === 'required_host_missing')
        .flatMap((failure) => failure.hostDiagnostics || []),
      degraded: findings.some((finding) => finding?.degraded),
      extra: [
        exploratoryLoop?.unresolvedGaps?.length
          ? `Unresolved gaps: ${exploratoryLoop.unresolvedGaps.map((gap) => `${gap.id} (${gap.status}) ${gap.question}`).join('; ')}`
          : null,
        materialBlockedSlots.length
          ? `Blocked slots: ${materialBlockedSlots.map((gap) => (
            `${gap.gapId}${gap.answerSlot ? ` (${gap.answerSlot})` : ''}: ${gap.blockedReason}`
          )).join('; ')}.`
          : null,
        ...findings.flatMap((finding) => [finding, ...(finding.sources || [])])
          .map((entry) => archiveDisclosureText(entry))
          .filter(Boolean),
        ...collectManualImportHints({
          gaps,
          readiness,
          findings,
          corpusDirs: settings?.search?.local?.dirs || [],
        }),
      ].filter(Boolean),
    };
    let canonical = buildResearchLimitations(limitationBase);
    let reportLimitations = canonical.limitations;
    const reportContract = buildReportContract({
      gaps,
      brief: resolvedBrief,
      readiness,
      strategy,
      stopReason,
    });
    const openJudgment = reportContract.openJudgment;
    const incompleteContract = reportContract.incompleteContract;
    let reportPlan = buildReportPlan({
      contract: reportContract,
      findings,
      passages: passageArtifacts.passages,
      citationMap: passageArtifacts.citationMap,
      brief: resolvedBrief,
      limitations: reportLimitations,
      query,
      gaps,
    });
    recorder.checkpoint('report-contract', {
      strategy,
      query,
      reportContract,
      reportPlan,
    });
    recorder.checkpoint('pre-report', {
      embeddingStats: researchProviders.embedding?.stats ? { ...researchProviders.embedding.stats } : null,
      evidenceStore: passageArtifacts.evidenceStore || null,
      strategy,
      query,
      brief: resolvedBrief,
      findings,
      gaps,
      passages: passageArtifacts.passages,
      sources: passageArtifacts.sources,
      limitations: reportLimitations,
      reportContract,
      reportPlan,
      report: {
        maxPassageChars: evidenceOptions.maxPassageChars,
        maxTokens: reportSettings.maxOutputTokens,
        minChars: reportSettings.minChars,
        maxAttempts: reportSettings.maxAttempts,
        openJudgment,
        incompleteContract,
      },
      budget: budget.exportCheckpoint(),
      queryMemory: queryMemory.exportCheckpoint(),
      trace,
    });
    return finalizePreparedReport({
      embedding: researchProviders.embedding,
      embeddingStats: researchProviders.embedding?.stats || null,
      llm,
      signal,
      emit,
      recorder,
      budget,
      settings,
      strategy,
      query,
      resolvedBrief,
      findings,
      gaps,
      passageArtifacts,
      reportSettings,
      evidenceOptions,
      exploratoryLoop,
      focusedControl,
      preReport,
      readiness,
      stopReason,
      stopDetail,
      controlProfile,
      contractUnavailable,
      focusedFailures,
      limitationBase,
      reportContract,
      reportPlan,
      openJudgment,
      incompleteContract,
      reportLimitations,
      canonical,
      budgetBeforeReport,
      trace,
    });
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
