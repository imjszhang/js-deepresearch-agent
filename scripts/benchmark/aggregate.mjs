import { calculateQualityMetrics } from 'js-deepresearch-engine';
import { sourceIsComplete } from './rule-score.mjs';

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function collectRiskExamples(results = []) {
  return results
    .filter((result) => result.rule.flags.length > 0
      || ['partially_supported', 'unsupported', 'unverifiable', 'conflicting'].includes(result.effectiveEvaluation?.verdict))
    .slice(0, 10)
    .map((result) => ({
      section: result.claim.section,
      kind: result.claim.kind,
      text: result.claim.text,
      flags: result.rule.flags,
      unresolvedCitations: result.rule.unresolvedCitations,
      effectiveVerdict: result.effectiveEvaluation?.verdict || 'unverifiable',
      evaluationOrigin: result.effectiveEvaluation?.origin || 'not_evaluated',
      reason: result.llm?.reason || null,
    }));
}

export function aggregateBenchmark({
  meta,
  artifactsHealth,
  claimResults = [],
  llmEnabled = false,
  llmInvoked = false,
}) {
  const evaluatedClaims = claimResults.map((result) => ({
    ...result.claim,
    evaluation: result.effectiveEvaluation,
  }));
  const quality = calculateQualityMetrics(evaluatedClaims);
  const factResults = claimResults.filter((result) => result.claim.kind === 'key_claim');
  const claimsWithCitations = factResults.filter((result) => result.rule.hasCitations).length;
  const totalCitations = factResults.reduce((sum, result) => sum + result.rule.citationKeys.length, 0);
  const unresolvedCitations = factResults.reduce((sum, result) => sum + result.rule.unresolvedCitations.length, 0);
  const resolvedSources = factResults.flatMap((result) => result.rule.resolvedSources);
  const completeSources = resolvedSources.filter((entry) => sourceIsComplete(entry.source || {})).length;
  const platformMatches = factResults.filter((result) => result.rule.platformMatch).length;

  return {
    query: meta?.query || '',
    strategy: meta?.strategy || '',
    researchId: meta?.researchId || null,
    llmEnabled,
    evaluation: {
      metricsVersion: quality.metricsVersion,
      claimExtractionVersion: quality.claimExtractionVersion,
      claimEvaluationVersion: quality.claimEvaluationVersion,
      storedEvaluationVersions: [...new Set(claimResults
        .map((result) => result.effectiveEvaluation?.evaluationVersion)
        .filter((value) => Number.isFinite(value)))],
      llmInvoked,
      usedStoredRule: claimResults.some((result) => result.effectiveEvaluation?.origin === 'stored_rule'),
      usedStoredLlm: claimResults.some((result) => result.effectiveEvaluation?.origin === 'stored_llm'),
      usedRuntimeRule: claimResults.some((result) => result.effectiveEvaluation?.origin === 'runtime_rule'),
      usedRuntimeLlm: claimResults.some((result) => result.effectiveEvaluation?.origin === 'runtime_llm'),
    },
    artifactsHealth,
    metrics: {
      ...quality,
      claimsWithCitationsRate: rate(claimsWithCitations, factResults.length),
      citationResolutionRate: rate(totalCitations - unresolvedCitations, totalCitations),
      sourcePresenceRate: rate(completeSources, resolvedSources.length),
      platformMatchRate: rate(platformMatches, factResults.length),
      enrichOkRate: artifactsHealth?.enrichment?.enrichOkRate ?? 0,
      contentPresenceRate: artifactsHealth?.enrichment?.contentRate ?? 0,
      // Backward-compatible aliases; canonical values live under rates.
      supportedRate: quality.rates.supportedRate,
      partialRate: quality.rates.partiallySupportedRate,
      unsupportedRate: quality.rates.unsupportedRate,
      unverifiableRate: quality.rates.unverifiableRate,
      conflictingRate: quality.rates.conflictingRate,
    },
    claims: claimResults,
    riskExamples: collectRiskExamples(claimResults),
  };
}
