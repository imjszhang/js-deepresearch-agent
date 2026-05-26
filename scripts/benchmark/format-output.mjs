function formatPercent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

export function formatMarkdownSummary(result) {
  const { metrics, artifactsHealth, riskExamples } = result;
  const lines = [
    '# Research Benchmark',
    '',
    `- Query: ${result.query || '(unknown)'}`,
    `- Strategy: ${result.strategy || '(unknown)'}`,
    `- LLM judge: ${result.llmEnabled ? 'enabled' : 'disabled'}`,
    '',
    '## Metrics',
    '',
    `- claimCount: ${metrics.claimCount}`,
    `- claimsWithCitationsRate: ${formatPercent(metrics.claimsWithCitationsRate)}`,
    `- citationResolutionRate: ${formatPercent(metrics.citationResolutionRate)}`,
    `- sourcePresenceRate: ${formatPercent(metrics.sourcePresenceRate)}`,
    `- platformMatchRate: ${formatPercent(metrics.platformMatchRate)}`,
    `- supportedRate: ${formatPercent(metrics.supportedRate)}`,
    `- partialRate: ${formatPercent(metrics.partialRate)}`,
    `- unsupportedRate: ${formatPercent(metrics.unsupportedRate)}`,
    `- unverifiableRate: ${formatPercent(metrics.unverifiableRate)}`,
  ];

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
      if (example.llmVerdict) {
        lines.push(`  - llm: ${example.llmVerdict}${example.llmReason ? ` (${example.llmReason})` : ''}`);
      }
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
    artifactsHealth: result.artifactsHealth,
    metrics: result.metrics,
    riskExamples: result.riskExamples,
    claims: result.claims.map((entry) => ({
      section: entry.claim.section,
      text: entry.claim.text,
      citationKeys: entry.rule.citationKeys,
      unresolvedCitations: entry.rule.unresolvedCitations,
      keywordOverlap: entry.rule.keywordOverlap,
      flags: entry.rule.flags,
      llm: entry.llm || null,
    })),
  }, null, 2);
}
