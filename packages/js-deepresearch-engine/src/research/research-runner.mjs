import { createLlmProvider } from '../llm/provider-factory.mjs';
import { createSearchEngine } from '../search/search-factory.mjs';
import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { createProgressEmitter } from './progress-events.mjs';
import { buildReport, ReportGenerationError, validateReportOutput } from './report-builder.mjs';
import { assembleReport, reviseUnsupportedKeyClaims, shouldMoveWeakKeyClaim } from './report-assembler.mjs';
import { resolveReportSettings } from './report-settings.mjs';
import { runStrategy } from './strategies.mjs';
import { BudgetManager, BudgetExceededError, wrapProvidersWithBudget } from './budget-manager.mjs';
import { QueryMemory } from './query-memory.mjs';
import { alignReportClaims, buildPassageArtifactsAsync, listSnippetOnlyCitationKeys } from './evidence-chain.mjs';
import { evaluatePreReport } from './quality-gates.mjs';
import { applyAsOfGate, resolveCompletionStatus } from './as-of.mjs';
import { applySlotStatusToClaims } from './report-evidence.mjs';
import { archiveDisclosureText } from './alternate-evidence.mjs';
import { closeHeadlessPool } from './headless-backend.mjs';
import { plannerFactsFromSnapshot } from './transport-memory.mjs';
import { buildResearchLimitations } from './limitations.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { createResearchProviders } from './research-providers.mjs';
import { calculateQualityMetrics, normalizedClaimKey, qualityGateFromClaims } from './claim-quality.mjs';
import { extractClaimsFromDocument } from './claim-quality.mjs';
import { applyClaimEntailment } from './claim-entailment.mjs';
import { researchBriefFromInput } from './research-brief.mjs';
import { collectGapSources, evaluateGapEvidence, rollupRootGap } from './gap-state.mjs';
import { recorderOrNoop } from './run-recorder.mjs';
import { buildReportContract } from './report-contract.mjs';
import {
  buildReportPlan,
  documentFromPlan,
  ensureKeyFindingPlacements,
  mergeNarrativeIntoPlan,
  validateReportPlan,
} from './report-plan.mjs';
import { parseMarkdownNarrative, renderNarrativeMarkdown } from './report-narrative.mjs';

export class ResearchRunner {
  async run({
    query,
    settings,
    signal,
    onProgress = () => {},
    llm: providedLlm,
    search: providedSearch,
    recorder: providedRecorder,
  }) {
    const recorder = recorderOrNoop(providedRecorder);
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'focused';
    const queryWasStructured = typeof query === 'object' && query !== null;
    const brief = researchBriefFromInput(query, { depth: strategy });
    query = brief.query;
    const emit = createProgressEmitter(onProgress);
    const trace = [];
    const appendTrace = Array.prototype.push.bind(trace);
    Object.defineProperty(trace, 'push', {
      enumerable: false,
      configurable: false,
      value: (...entries) => {
        for (const entry of entries) recorder.event('trace', entry);
        return appendTrace(...entries);
      },
    });
    trace.push({
      step: 1,
      action: 'research_brief',
      reasonCode: queryWasStructured ? 'structured_input' : 'query_compatibility_input',
      brief,
      createdAt: new Date().toISOString(),
    });
    recorder.event('research_brief', {
      strategy,
      query,
      brief,
      queryWasStructured,
    });
    const budget = new BudgetManager(settings, emit);
    const { llm, search } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      recorder,
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
      recorder,
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
    recorder.checkpoint('research-start', {
      strategy,
      query,
      brief,
      budget: budget.exportCheckpoint(),
      queryMemory: queryMemory.exportCheckpoint(),
      trace,
    });

    try {
    emit({ stage: 'research_started' });
    let findings;
    try {
      findings = await runStrategy({
        strategy,
        query,
        brief,
        settings,
        llm,
        search,
        signal,
        emit,
        budget,
        queryMemory,
        trace,
        researchProviders,
        recorder,
      });
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
        exploratoryLoop?.blockedHosts?.length
          ? `Blocked or unread required hosts: ${exploratoryLoop.blockedHosts.join(', ')}.`
          : null,
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
    const reportOnAttempt = (event) => {
      trace.push({
        step: trace.length + 1,
        action: event.status === 'invalid' ? 'report_retry_requested' : 'draft',
        reasonCode: event.status === 'invalid' ? event.flags?.[0] : `report_attempt_${event.status}`,
        ...event,
        createdAt: new Date().toISOString(),
      });
      if (event.status === 'invalid') emit({ stage: 'report_retrying', ...event });
    };
    const generateNarrative = async (retryContext = null) => buildReport({
      llm,
      query,
      findings,
      signal,
      purpose: 'report',
      limitations: reportLimitations,
      strategy,
      passages: passageArtifacts.passages,
      maxPassageChars: evidenceOptions.maxPassageChars,
      maxTokens: reportSettings.maxOutputTokens,
      minChars: reportSettings.minChars,
      maxAttempts: retryContext ? 1 : reportSettings.maxAttempts,
      mode: 'narrative',
      gaps,
      brief: resolvedBrief,
      contract: reportContract,
      openJudgment,
      incompleteContract,
      retryContext,
      onAttempt: reportOnAttempt,
    });
    const assembleCurrentReport = (narrative, limitations = reportLimitations) => assembleReport({
      narrative,
      findings,
      passages: passageArtifacts.passages,
      maxPassageChars: evidenceOptions.maxPassageChars,
      limitations,
      query,
    });
    const validationOptions = {
      minChars: reportSettings.minChars,
      findings,
      openJudgment,
      incompleteContract,
    };
    const checkReportPair = (narrative, assembled) => {
      const narrativeCheck = validateReportOutput(narrative, { ...validationOptions, mode: 'narrative' });
      const fullCheck = validateReportOutput(assembled, { ...validationOptions, mode: 'full' });
      return {
        ok: narrativeCheck.ok && fullCheck.ok,
        flags: [...new Set([...(narrativeCheck.flags || []), ...(fullCheck.flags || [])])],
        failedChecks: [
          ...(narrativeCheck.failedChecks || []),
          ...(fullCheck.failedChecks || []).filter((item) => (
            !(narrativeCheck.failedChecks || []).some((existing) => existing.check === item.check)
          )),
        ],
        outputChars: narrativeCheck.outputChars,
      };
    };
    const draft = await generateNarrative();
    let reportProviderCalls = draft.diagnostics?.providerCalls || 1;
    let reportAttemptCounts = mergeReportAttemptCounts(draft.diagnostics?.attemptCounts);
    let narrativeDocument = draft.document || parseMarkdownNarrative(draft.text);
    let narrativeDraft = draft.text;
    reportPlan = mergeNarrativeIntoPlan(reportPlan, narrativeDocument);
    narrativeDocument = documentFromPlan(reportPlan);
    narrativeDraft = renderNarrativeMarkdown(narrativeDocument);
    recorder.checkpoint('report-draft', {
      strategy,
      query,
      narrativeDraft,
      narrativeDocument,
      limitations: reportLimitations,
      budget: budget.exportCheckpoint(),
      trace,
    });
    recorder.checkpoint('report-plan', {
      strategy,
      query,
      reportPlan,
      reportContract,
    });
    let report = assembleCurrentReport(narrativeDraft);
    if (!evidenceOptions.claimAlignment && findings.length > 0) {
      const assembledCheck = checkReportPair(narrativeDraft, report);
      if (!assembledCheck.ok) {
        reportAttemptCounts.render += 1;
        throw new ReportGenerationError({
          attempts: reportProviderCalls,
          minChars: reportSettings.minChars,
          outputChars: assembledCheck.outputChars,
          flags: assembledCheck.flags,
          failedChecks: assembledCheck.failedChecks,
          phase: 'render',
          contract: reportContract,
          attemptCounts: reportAttemptCounts,
        });
      }
    }
    let claims = [];
    let movedClaimTexts = [];
    if (evidenceOptions.claimAlignment) {
      emit({ stage: 'evaluating_report' });
      trace.push({ step: trace.length + 1, action: 'evaluate_report', reasonCode: 'claim_evidence_alignment', createdAt: new Date().toISOString() });
      const entailmentMode = settings?.research?.quality?.entailment || 'rules_then_llm';
      const entailmentCache = new Map();
      const judgeClaims = async (currentClaims) => applyAsOfGate(await applyClaimEntailment(currentClaims, {
        llm,
        passages: passageArtifacts.passages,
        signal,
        mode: entailmentMode,
        cache: entailmentCache,
      }), {
        asOf: resolvedBrief?.asOf,
        sources: passageArtifacts.sources,
        passages: passageArtifacts.passages,
      });
      const alignAndJudge = async (assembled, document) => {
        const fromReport = alignReportClaims({
          report: assembled,
          passages: passageArtifacts.passages,
          citationMap: passageArtifacts.citationMap,
          options: { ...evidenceOptions, strategy },
        });
        const fromPlan = document ? extractClaimsFromDocument(document) : [];
        const merged = fromReport.map((claim) => {
          const match = fromPlan.find((item) => (
            item.kind === claim.kind
            && normalizedClaimKey(item.text) === normalizedClaimKey(claim.text)
          ));
          if (!match) return claim;
          return {
            ...claim,
            canonicalClaimId: match.canonicalClaimId || claim.canonicalClaimId,
            placements: match.placements || claim.placements,
            boundSlotIds: match.boundSlotIds || claim.boundSlotIds,
            origin: match.origin || claim.origin,
            claimRole: match.claimRole || claim.claimRole,
          };
        });
        return applySlotStatusToClaims(await judgeClaims(merged), { gaps, findings, brief: resolvedBrief });
      };
      const reviseFrom = async (narrative, document = null) => {
        const assembled = assembleCurrentReport(narrative, reportLimitations);
        const judged = await alignAndJudge(assembled, document);
        const revision = reviseUnsupportedKeyClaims(narrative, judged, { document });
        movedClaimTexts = revision.moved.map((text) => {
          const claim = judged.find((item) => item.text === text);
          const verified = (claim?.boundSlotIds || []).some((id) => reportContract.verifiedSlotIds.includes(id));
          return verified ? { text, verifiedSlot: true } : text;
        });
        canonical = buildResearchLimitations({
          ...limitationBase,
          movedClaims: movedClaimTexts,
        });
        reportLimitations = canonical.limitations;
        let nextDocument = ensureKeyFindingPlacements(
          revision.document || parseMarkdownNarrative(revision.report),
          judged,
          reportContract,
        );
        reportPlan = mergeNarrativeIntoPlan(reportPlan, nextDocument);
        nextDocument = documentFromPlan(reportPlan);
        narrativeDocument = nextDocument;
        narrativeDraft = renderNarrativeMarkdown(nextDocument);
        report = assembleCurrentReport(narrativeDraft, reportLimitations);
        claims = (revision.changed || narrativeDraft !== narrative)
          ? await alignAndJudge(report, nextDocument)
          : judged;
        const planCheck = validateReportPlan(reportPlan, reportContract);
        const renderCheck = checkReportPair(narrativeDraft, report);
        if (planCheck.ok && !renderCheck.ok) {
          narrativeDraft = renderNarrativeMarkdown(nextDocument);
          report = assembleCurrentReport(narrativeDraft, reportLimitations);
          const retryRender = checkReportPair(narrativeDraft, report);
          return {
            ok: retryRender.ok,
            flags: retryRender.flags,
            failedChecks: retryRender.failedChecks,
            outputChars: retryRender.outputChars,
            phase: retryRender.ok ? null : 'render',
          };
        }
        const planFailedChecks = (planCheck.failedChecks || []).filter((item) => (
          !(renderCheck.failedChecks || []).some((existing) => existing.check === item.check)
        ));
        return {
          ok: planCheck.ok && renderCheck.ok,
          flags: [...new Set([...(planCheck.flags || []), ...(renderCheck.flags || [])])],
          failedChecks: [...planFailedChecks, ...(renderCheck.failedChecks || [])],
          outputChars: renderCheck.outputChars,
          phase: !planCheck.ok ? 'semantic-contract' : (!renderCheck.ok ? 'render' : null),
        };
      };
      let revisedCheck = await reviseFrom(narrativeDraft, narrativeDocument);
      if (!revisedCheck.ok) incrementReportAttemptCount(reportAttemptCounts, revisedCheck.phase);
      if (!revisedCheck.ok && findings.length > 0) {
        const retryEvent = {
          flags: revisedCheck.flags,
          reasonCode: 'post_revision_narrative',
          attempt: reportSettings.maxAttempts + 1,
          maxAttempts: reportSettings.maxAttempts + 1,
          phase: revisedCheck.phase || 'semantic-contract',
        };
        trace.push({
          step: trace.length + 1,
          action: 'report_retry_requested',
          ...retryEvent,
          createdAt: new Date().toISOString(),
        });
        emit({ stage: 'report_retrying', ...retryEvent });
        const retrySeeds = {
          ...admissibleReportSeeds(claims),
          contract: reportContract,
          admissibleClaims: claims
            .filter((claim) => claim.evaluation?.verdict === 'supported' || (claim.placements || []).includes('key_findings'))
            .map((claim) => ({
              text: claim.text,
              placement: (claim.placements || [])[0] || (claim.kind === 'premise_fact' ? 'background' : 'key_findings'),
              boundSlotIds: claim.boundSlotIds || [],
            })),
        };
        let retried;
        try {
          retried = await generateNarrative(retrySeeds);
        } catch (error) {
          if (!(error instanceof ReportGenerationError)) throw error;
          throw new ReportGenerationError({
            attempts: reportProviderCalls + error.attempts,
            minChars: error.minChars,
            outputChars: error.outputChars,
            diagnostic: error.diagnostic,
            flags: error.flags,
            failedChecks: error.failedChecks,
            phase: error.phase,
            contract: reportContract,
            attemptCounts: mergeReportAttemptCounts(reportAttemptCounts, error.attemptCounts),
          });
        }
        reportProviderCalls += retried.diagnostics?.providerCalls || 1;
        reportAttemptCounts = mergeReportAttemptCounts(
          reportAttemptCounts,
          retried.diagnostics?.attemptCounts,
        );
        narrativeDocument = retried.document || parseMarkdownNarrative(retried.text);
        narrativeDraft = retried.text;
        reportPlan = mergeNarrativeIntoPlan(reportPlan, narrativeDocument);
        revisedCheck = await reviseFrom(narrativeDraft, narrativeDocument);
        if (!revisedCheck.ok) {
          incrementReportAttemptCount(reportAttemptCounts, revisedCheck.phase);
          throw new ReportGenerationError({
            attempts: reportProviderCalls,
            minChars: reportSettings.minChars,
            outputChars: revisedCheck.outputChars,
            flags: revisedCheck.flags,
            failedChecks: revisedCheck.failedChecks,
            phase: revisedCheck.phase || 'semantic-contract',
            contract: reportContract,
            attemptCounts: reportAttemptCounts,
          });
        }
      }
    }
    const evidence = {
      findings,
      sources: passageArtifacts.sources,
      passages: passageArtifacts.passages,
      claims,
      citationMap: passageArtifacts.citationMap,
    };
    recorder.checkpoint('claims-evaluated', {
      strategy,
      query,
      brief: resolvedBrief,
      findings: evidence.findings,
      sources: evidence.sources,
      passages: evidence.passages,
      claims: evidence.claims,
      citationMap: [...evidence.citationMap.entries()],
      budget: budget.exportCheckpoint(),
      trace,
    });
    const qualityMetrics = calculateQualityMetrics(evidence.claims);
    const claimGate = qualityGateFromClaims(evidence.claims);
    const unverifiedKeyClaims = evidence.claims.filter((claim) => (
      claim.kind === 'key_claim' && ['unsupported', 'unverifiable'].includes(claim.evaluation?.verdict)
    ));
    const noClaims = evidenceOptions.claimAlignment
      && qualityMetrics.keyClaimCount === 0
      && !incompleteContract
      && !(reportPlan.slotClaims || []).length;
    const emptyExtraction = evidenceOptions.claimAlignment && qualityMetrics.claimCount === 0;
    if (noClaims) {
      canonical = buildResearchLimitations({
        ...limitationBase,
        movedClaims: movedClaimTexts,
        extra: [
          ...limitationBase.extra,
          'No evaluable claims could be extracted from the report.',
        ],
      });
      reportLimitations = canonical.limitations;
      report = assembleCurrentReport(narrativeDraft, reportLimitations);
    }
    const finalGate = preReport.gate === 'fail' || claimGate === 'fail' || emptyExtraction
      ? 'fail'
      : (preReport.gate === 'pass_with_warnings' || claimGate === 'pass_with_warnings' || noClaims ? 'pass_with_warnings' : 'pass');
    const slotSupportUnknown = gaps.some((gap) => (
      gap?.slotSupport?.method === 'fail_closed' || gap?.slotSupport?.verdict === 'unverifiable'
    ));
    const planSatisfaction = validateReportPlan(reportPlan, reportContract);
    const quality = {
      schemaVersion: 4,
      reportContractSatisfied: planSatisfaction.ok,
      stopReason: budget.controllerStopReason || null,
      stopDetail,
      qualityMetricsVersion: qualityMetrics.metricsVersion,
      claimExtractionVersion: qualityMetrics.claimExtractionVersion,
      claimEvaluationVersion: qualityMetrics.claimEvaluationVersion,
      ...preReport,
      gate: finalGate,
      readiness,
      completionStatus: resolveCompletionStatus({
        readiness,
        stopReason,
        gaps,
      }),
      flags: [
        ...preReport.flags,
        ...focusedFailures.map((failure) => failure.code).filter(Boolean),
        ...(stopReason === 'budget_exhausted' || budgetBeforeReport.stopReason ? ['budget_exhausted'] : []),
        ...(controlProfile.contractRetried ? ['contract_plan_retried'] : []),
        ...(contractUnavailable ? ['contract_unavailable'] : []),
        ...(slotSupportUnknown ? ['slot_support_unknown'] : []),
        ...(noClaims ? ['no_claims'] : []),
        ...(unverifiedKeyClaims.length ? ['unverified_key_claims'] : []),
      ],
      limitations: canonical.limitations,
      limitationItems: canonical.items,
      limitationKeys: canonical.limitationKeys,
      metrics: {
        ...preReport.metrics,
        ...qualityMetrics,
        marginal: focusedControl?.marginal || exploratoryLoop?.marginal || null,
        relevance: exploratoryLoop?.relevance || null,
        recovery: exploratoryLoop?.recovery || focusedControl?.recovery || null,
        queryProvenance: focusedControl?.queryProvenance || exploratoryLoop?.recovery || null,
        observability: focusedControl?.observability || exploratoryLoop?.observability || null,
      },
      budget: budget.snapshot(),
    };
    reportPlan = {
      ...reportPlan,
      claims: evidence.claims,
      contract: reportContract,
    };
    recorder.checkpoint('research-complete', {
      strategy,
      query,
      brief: resolvedBrief,
      report,
      reportPlan,
      reportContract,
      findings,
      sources: evidence.sources,
      gaps,
      passages: evidence.passages,
      claims: evidence.claims,
      quality,
      trace,
    });
    emit({ stage: 'research_complete' });

    return {
      report,
      reportPlan,
      reportContract,
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
    } finally {
      await closeHeadlessPool().catch(() => {});
    }
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

function admissibleReportSeeds(claims = []) {
  return {
    premiseFacts: claims
      .filter((claim) => (
        claim.kind === 'premise_fact'
        && claim.evaluation?.verdict === 'supported'
        && (claim.evaluation?.flags || claim.flags || []).includes('slot_premise_exempt')
      ))
      .map((claim) => String(claim.text || '').trim())
      .filter(Boolean),
    keyClaims: claims
      .filter((claim) => claim.kind === 'key_claim' && !shouldMoveWeakKeyClaim(claim) && claim.evaluation?.verdict === 'supported')
      .map((claim) => String(claim.text || '').trim())
      .filter(Boolean),
  };
}

function mergeReportAttemptCounts(...counts) {
  const merged = {
    provider: 0,
    parse: 0,
    semanticContract: 0,
    render: 0,
  };
  for (const item of counts) {
    if (!item) continue;
    for (const key of Object.keys(merged)) merged[key] += Number(item[key]) || 0;
  }
  return merged;
}

function incrementReportAttemptCount(counts, phase) {
  if (phase === 'provider') counts.provider += 1;
  else if (phase === 'parse') counts.parse += 1;
  else if (phase === 'render') counts.render += 1;
  else counts.semanticContract += 1;
}
