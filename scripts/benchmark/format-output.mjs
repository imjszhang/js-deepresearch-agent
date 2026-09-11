function count(value) {
  return value === null || value === undefined ? 'unavailable' : String(value);
}

export function formatMarkdownSummary(result) {
  const { metrics, artifactVerification, modelAssessment } = result;
  const lines = [
    '# Research Artifact Verification', '',
    `- Query: ${result.query || '(unknown)'}`,
    `- Strategy: ${result.strategy || '(unknown)'}`,
    `- Schema: ${result.schemaVersion}`,
    `- Origin: ${result.origin}`,
    `- Artifact verification: ${artifactVerification.status}`,
    `- Scope: ${artifactVerification.scope}`,
    `- Revision: ${result.artifactMetadata?.resultRevision || 'unavailable'}`,
    ...(artifactVerification.reason ? [`- Reason: ${artifactVerification.reason}`] : []),
    `- Model observation: ${modelAssessment.observed ? 'observed' : 'not requested'}`,
    '- Semantic truth and extraction completeness: not verified', '',
    '## Observable Counts', '',
    `- Sources: ${count(metrics.sourceCount)}`,
    `- Source hosts: ${count(metrics.sourceHostCount)}`,
    `- Document versions: ${count(metrics.documentVersionCount)}`,
    `- Passages: ${count(metrics.passageCount)}`,
    `- Citation registry entries: ${count(metrics.citationEntryCount)}`,
    `- Report citation keys: ${count(metrics.reportCitationCount)}`,
    `- Resolved report citation keys: ${count(metrics.resolvedCitationCount)}`,
    `- Report characters: ${count(metrics.reportCharacterCount)}`,
  ];
  if (result.artifactsHealth.flags.length) lines.push('', '## Source Field Diagnostics', '', ...result.artifactsHealth.flags.map(flag => `- ${flag}`));
  return `${lines.join('\n')}\n`;
}

export function formatJsonSummary(result) {
  return JSON.stringify({
    schemaVersion: result.schemaVersion, origin: result.origin,
    query: result.query, strategy: result.strategy, researchId: result.researchId,
    llmEnabled: result.llmEnabled, evaluation: result.evaluation,
    artifactVerification: result.artifactVerification, modelAssessment: result.modelAssessment,
    artifactMetadata: result.artifactMetadata, artifactsHealth: result.artifactsHealth, metrics: result.metrics,
  }, null, 2);
}
