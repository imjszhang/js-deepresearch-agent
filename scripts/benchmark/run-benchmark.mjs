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
  const claims = extractClaims(artifacts.report);
  const artifactsHealth = summarizeFindingsHealth(artifacts.findings, artifacts.sources);

  const claimResults = [];
  for (const claim of claims) {
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

  return aggregateBenchmark({
    meta: artifacts.meta,
    artifactsHealth,
    claimResults,
    llmEnabled: llmEnabled && Boolean(llm),
  });
}
