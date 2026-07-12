import { loadArtifacts, loadArtifactsByResearchId } from './load-artifacts.mjs';
import { buildCitationMap } from './citations.mjs';
import { extractClaims } from './claims.mjs';
import { scoreClaimRule, summarizeFindingsHealth } from './rule-score.mjs';
import { judgeClaimWithLlm } from './llm-judge.mjs';
import { aggregateBenchmark } from './aggregate.mjs';

export async function runBenchmark({
  workDir,
  researchId = null,
  engine = null,
  strictPlatform = null,
  llm = null,
  llmEnabled = true,
}) {
  const artifacts = researchId
    ? loadArtifactsByResearchId(researchId, engine ? { engine } : {})
    : loadArtifacts(workDir);
  const citationMap = buildCitationMap(artifacts.findings);
  const claims = Array.isArray(artifacts.claims) && artifacts.claims.length
    ? artifacts.claims
    : extractClaims(artifacts.report);
  const artifactsHealth = summarizeFindingsHealth(artifacts.findings, artifacts.sources);

  const claimResults = [];
  for (const claim of claims) {
    if (Array.isArray(claim.evidence)) {
      const verdicts = claim.evidence.map((item) => item.verdict);
      const verdict = verdicts.includes('supported') ? 'supported'
        : (verdicts.includes('partially_supported') ? 'partially_supported'
          : (verdicts.includes('unsupported') ? 'unsupported' : 'unverifiable'));
      const resolvedSources = claim.evidence.map((entry) => ({
        source: artifacts.sources.find((source) => source.id === entry.sourceId) || {},
        passage: artifacts.passages?.find((passage) => passage.id === entry.passageId) || null,
      }));
      claimResults.push({
        claim,
        rule: {
          flags: resolvedSources.some((item) => !item.passage) ? ['missing_passage'] : [],
          hasCitations: claim.evidence.length > 0,
          citationKeys: claim.evidence.map((entry) => entry.passageId),
          unresolvedCitations: resolvedSources.filter((item) => !item.passage).map((item) => item.passage),
          resolvedSources,
          platformMatch: !strictPlatform || resolvedSources.every((item) => item.source.engine === strictPlatform),
        },
        llm: { verdict, confidence: Math.max(0, ...claim.evidence.map((entry) => Number(entry.score) || 0)), reason: 'Loaded from Schema v3 evidence alignment.', skipped: !llmEnabled },
      });
      continue;
    }
    const rule = scoreClaimRule(claim, citationMap, { strictPlatform });
    const llmResult = llmEnabled
      ? await judgeClaimWithLlm(claim, rule, llm)
      : {
          verdict: 'unverifiable',
          confidence: 0,
          reason: 'LLM judge disabled.',
          skipped: true,
        };

    claimResults.push({ claim, rule, llm: llmResult });
  }

  const result = aggregateBenchmark({
    meta: artifacts.meta,
    artifactsHealth,
    claimResults,
    llmEnabled: llmEnabled && Boolean(llm),
  });
  const keyClaims = claims.filter((claim) => claim.importance === 'key');
  const linkedKeyClaims = keyClaims.filter((claim) => claim.evidence?.some((entry) => entry.passageId));
  const sourceHosts = new Set(artifacts.sources.map((source) => {
    try { return new URL(source.url).hostname; } catch { return ''; }
  }).filter(Boolean));
  result.metrics.keyClaimEvidenceCoverageRate = keyClaims.length ? Number((linkedKeyClaims.length / keyClaims.length).toFixed(4)) : 0;
  result.metrics.sourceHostCount = sourceHosts.size;
  result.metrics.passageCount = artifacts.passages?.length || 0;
  result.metrics.averageSourcesPerClaim = claims.length
    ? Number((claims.reduce((sum, claim) => sum + new Set((claim.evidence || []).map((entry) => entry.sourceId)).size, 0) / claims.length).toFixed(4))
    : 0;
  return result;
}
