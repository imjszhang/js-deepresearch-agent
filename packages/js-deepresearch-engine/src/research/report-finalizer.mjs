import { buildReport, ReportGenerationError, validateReportOutput } from './report-builder.mjs';
import { assembleReport, reviseUnsupportedKeyClaims, shouldMoveWeakKeyClaim } from './report-assembler.mjs';
import { alignReportClaims } from './evidence-chain.mjs';
import { applyAsOfGate, resolveCompletionStatus } from './as-of.mjs';
import { applySlotStatusToClaims } from './report-evidence.mjs';
import { buildResearchLimitations } from './limitations.mjs';
import { calculateQualityMetrics, normalizedClaimKey, qualityGateFromClaims } from './claim-quality.mjs';
import { extractClaimsFromDocument } from './claim-quality.mjs';
import { applyClaimEntailment } from './claim-entailment.mjs';
import crypto from 'node:crypto';
import { documentFromPlan, ensureKeyFindingPlacements, mergeNarrativeIntoPlan, validateReportPlan } from './report-plan.mjs';
import { parseMarkdownNarrative, renderNarrativeMarkdown } from './report-narrative.mjs';
import { finalizeCanonicalReport } from './canonical-report.mjs';

export async function finalizePreparedReport({
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
  embeddingStats = null,
  embedding = null,
}) {
    if (resolvedBrief?.executionVersion === 2 && strategy !== 'quick') return finalizeCanonicalReport({
      llm, signal, emit, recorder, budget, settings, strategy, query, resolvedBrief, findings, gaps, passageArtifacts,
      reportSettings, evidenceOptions, exploratoryLoop, focusedControl, preReport, readiness, stopReason, stopDetail,
      controlProfile, contractUnavailable, focusedFailures, limitationBase, reportContract, reportPlan, openJudgment,
      incompleteContract, reportLimitations, canonical, budgetBeforeReport, trace, embeddingStats, embedding,
    });
    canonical ||= buildResearchLimitations(limitationBase);
    budgetBeforeReport ||= budget.snapshot();
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
    const result = {
      resultRevision: crypto.randomUUID(),
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
    recorder.checkpoint('research-complete', {
      result,
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

    return result;

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
