function formatPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

export function formatMarkdownSummary(result) {
  const { metrics, artifactsHealth, riskExamples } = result;
  const lines = [
    '# Research Benchmark',
    '',
    `- Query: ${result.query || '(unknown)'}`,
    `- Strategy: ${result.strategy || '(unknown)'}`,
    `- LLM judge invoked: ${result.evaluation?.llmInvoked ? 'yes' : 'no'}`,
    '',
    '## Metrics',
    '',
    `- Claims: ${metrics.evaluatedClaimCount} evaluated (${metrics.keyClaimCount} key, ${metrics.supportingClaimCount} supporting)`,
    `- Supported: ${metrics.claims.supported} (${formatPercent(metrics.rates.supportedRate)})`,
    `- Partial: ${metrics.claims.partiallySupported} (${formatPercent(metrics.rates.partiallySupportedRate)})`,
    `- Unsupported: ${metrics.claims.unsupported} (${formatPercent(metrics.rates.unsupportedRate)})`,
    `- Unverifiable: ${metrics.claims.unverifiable} (${formatPercent(metrics.rates.unverifiableRate)})`,
    `- Conflicting: ${metrics.claims.conflicting} (${formatPercent(metrics.rates.conflictingRate)})`,
    `- Key claims supported: ${formatPercent(metrics.rates.keyClaimSupportedRate)}`,
    `- Evidence coverage: ${formatPercent(metrics.rates.evidenceCoverageRate)}`,
    `- Direct evidence coverage: ${formatPercent(metrics.rates.directEvidenceRate)}`,
    `- claimsWithCitationsRate: ${formatPercent(metrics.claimsWithCitationsRate)}`,
    `- citationResolutionRate: ${formatPercent(metrics.citationResolutionRate)}`,
    `- sourcePresenceRate: ${formatPercent(metrics.sourcePresenceRate)}`,
    `- platformMatchRate: ${formatPercent(metrics.platformMatchRate)}`,
    `- enrichOkRate: ${formatPercent(metrics.enrichOkRate)}`,
    `- contentPresenceRate: ${formatPercent(metrics.contentPresenceRate)}`,
  ];

  if (artifactsHealth.enrichment) {
    const { enrichment } = artifactsHealth;
    lines.push(
      '',
      '## Source Enrichment',
      '',
      `- sources: ${artifactsHealth.sourceCount}`,
      `- withEvidence: ${enrichment.withEvidence}`,
      `- withContent: ${enrichment.withContent}`,
      `- enrichOk: ${enrichment.enrichOk}`,
      `- enrichFailed: ${enrichment.enrichFailed}`,
    );
  }

  if (artifactsHealth.flags.length > 0) {
    lines.push('', '## Artifact Health Flags', '');
    for (const flag of artifactsHealth.flags) {
      lines.push(`- ${flag}`);
    }
  }

  if (riskExamples.length > 0) {
    lines.push('', '## Risk Examples', '');
    for (const example of riskExamples) {
      lines.push(`- [${example.section}] ${example.text}`);
      if (example.flags.length > 0) {
        lines.push(`  - flags: ${example.flags.join(', ')}`);
      }
      if (example.unresolvedCitations.length > 0) {
        lines.push(`  - unresolved: ${example.unresolvedCitations.join(', ')}`);
      }
      lines.push(`  - verdict: ${example.effectiveVerdict} (${example.evaluationOrigin})${example.reason ? ` — ${example.reason}` : ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatJsonSummary(result) {
  return JSON.stringify({
    query: result.query,
    strategy: result.strategy,
    researchId: result.researchId,
    llmEnabled: result.llmEnabled,
    evaluation: result.evaluation,
    artifactsHealth: result.artifactsHealth,
    metrics: result.metrics,
    riskExamples: result.riskExamples,
    claims: result.claims.map((entry) => ({
      section: entry.claim.section,
      kind: entry.claim.kind,
      text: entry.claim.text,
      citationKeys: entry.rule.citationKeys,
      unresolvedCitations: entry.rule.unresolvedCitations,
      keywordOverlap: entry.rule.keywordOverlap,
      flags: entry.rule.flags,
      ruleVerdict: entry.ruleVerdict,
      llmVerdict: entry.llmVerdict,
      effectiveVerdict: entry.effectiveVerdict,
      evaluationOrigin: entry.evaluationOrigin,
      llm: entry.llm || null,
    })),
  }, null, 2);
}
