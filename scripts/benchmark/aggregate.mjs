function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function collectRiskExamples(results = []) {
  return results
    .filter((result) => {
      const llmVerdict = result.llm?.verdict;
      return result.rule.flags.length > 0
        || llmVerdict === 'unsupported'
        || llmVerdict === 'partially_supported';
    })
    .slice(0, 10)
    .map((result) => ({
      section: result.claim.section,
      text: result.claim.text,
      flags: result.rule.flags,
      unresolvedCitations: result.rule.unresolvedCitations,
      llmVerdict: result.llm?.verdict || null,
      llmReason: result.llm?.reason || null,
    }));
}

export function aggregateBenchmark({
  meta,
  artifactsHealth,
  claimResults = [],
  llmEnabled = false,
}) {
  const claimCount = claimResults.length;
  const claimsWithCitations = claimResults.filter((result) => result.rule.hasCitations).length;
  const totalCitations = claimResults.reduce(
    (sum, result) => sum + result.rule.citationKeys.length,
    0,
  );
  const unresolvedCitations = claimResults.reduce(
    (sum, result) => sum + result.rule.unresolvedCitations.length,
    0,
  );
  const resolvedCitationCount = totalCitations - unresolvedCitations;
  const resolvedSources = claimResults.flatMap((result) => result.rule.resolvedSources);
  const completeSources = resolvedSources.filter((entry) => {
    const source = entry.source || {};
    return Boolean(source.title && source.url && source.snippet);
  }).length;
  const platformMatches = claimResults.filter((result) => result.rule.platformMatch).length;

  const llmResults = claimResults.filter((result) => result.llm && !result.llm.skipped);
  const supported = llmResults.filter((result) => result.llm.verdict === 'supported').length;
  const partial = llmResults.filter((result) => result.llm.verdict === 'partially_supported').length;
  const unsupported = llmResults.filter((result) => result.llm.verdict === 'unsupported').length;
  const unverifiable = llmResults.filter((result) => result.llm.verdict === 'unverifiable').length;

  return {
    query: meta?.query || '',
    strategy: meta?.strategy || '',
    researchId: meta?.researchId || null,
    llmEnabled,
    artifactsHealth,
    metrics: {
      claimCount,
      claimsWithCitationsRate: rate(claimsWithCitations, claimCount),
      citationResolutionRate: rate(resolvedCitationCount, totalCitations),
      sourcePresenceRate: rate(completeSources, resolvedSources.length),
      platformMatchRate: rate(platformMatches, claimCount),
      supportedRate: rate(supported, llmResults.length),
      partialRate: rate(partial, llmResults.length),
      unsupportedRate: rate(unsupported, llmResults.length),
      unverifiableRate: rate(unverifiable, llmResults.length),
    },
    claims: claimResults,
    riskExamples: collectRiskExamples(claimResults),
  };
}
