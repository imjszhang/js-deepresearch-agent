import {
  CLAIM_EVALUATION_VERSION,
  buildClaimEvaluation,
  normalizeClaim,
} from 'js-deepresearch-engine';
import { loadArtifacts, loadArtifactsByResearchId } from './load-artifacts.mjs';
import { buildCitationMap } from './citations.mjs';
import { extractClaims } from './claims.mjs';
import { scoreClaimRule, summarizeFindingsHealth } from './rule-score.mjs';
import { judgeClaimWithLlm } from './llm-judge.mjs';
import { aggregateBenchmark } from './aggregate.mjs';

function schemaV3Rule(claim, artifacts, strictPlatform) {
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
  const citationKeys = claim.citationKeys?.length
    ? claim.citationKeys
    : evidence.map((entry) => entry.passageId).filter(Boolean);
  const unresolvedCitations = [
    ...(claim.unresolvedCitationKeys || []),
    ...evidence
      .filter((entry) => entry.passageId && !artifacts.passages?.some((passage) => passage.id === entry.passageId))
      .map((entry) => entry.passageId),
  ];
  const resolvedSources = (claim.citedSourceIds?.length ? claim.citedSourceIds : evidence.map((entry) => entry.sourceId))
    .filter(Boolean)
    .map((sourceId) => ({
      key: sourceId,
      source: artifacts.sources.find((source) => source.id === sourceId) || {},
      passage: artifacts.passages?.find((passage) => passage.sourceId === sourceId) || null,
    }));
  const borrowedEvidence = evidence.filter((entry) => (
    claim.citedSourceIds?.length && !claim.citedSourceIds.includes(entry.sourceId)
  ));
  const flags = [...new Set([
    ...(claim.flags || []),
    ...(unresolvedCitations.length ? ['unresolved_citation'] : []),
    ...(borrowedEvidence.length ? ['borrowed_uncited_source'] : []),
  ])];
  return {
    claim,
    flags,
    hasCitations: citationKeys.length > 0,
    citationKeys,
    unresolvedCitations,
    resolvedSources,
    platformMatch: !strictPlatform || resolvedSources.every((entry) => !entry.source.engine || entry.source.engine === strictPlatform),
    keywordOverlap: null,
  };
}

function evaluationFromLegacyRule(claim, rule) {
  let verdict = 'unverifiable';
  if (rule.resolvedSources.length > 0) {
    verdict = rule.citationsResolved && rule.sourcesComplete && rule.keywordOverlap >= 0.2
      ? 'supported'
      : 'partially_supported';
  }
  return {
    verdict,
    confidence: verdict === 'supported' ? rule.keywordOverlap : (verdict === 'partially_supported' ? Math.max(0.1, rule.keywordOverlap) : 0),
    method: 'rules',
    origin: 'runtime_rule',
    evaluatedAt: new Date().toISOString(),
    evaluationVersion: CLAIM_EVALUATION_VERSION,
    evidenceCounts: {
      supported: verdict === 'supported' ? 1 : 0,
      partiallySupported: verdict === 'partially_supported' ? 1 : 0,
      unsupported: 0,
      unverifiable: verdict === 'unverifiable' ? 1 : 0,
    },
  };
}

function storedEvaluation(claim) {
  const evaluation = claim.evaluation || buildClaimEvaluation(claim);
  return {
    ...evaluation,
    origin: evaluation.method === 'llm' ? 'stored_llm' : 'stored_rule',
    evaluationVersion: evaluation.evaluationVersion,
  };
}

function runtimeLlmEvaluation(llmResult, prior) {
  return {
    verdict: llmResult.verdict,
    confidence: llmResult.confidence,
    method: 'llm',
    origin: 'runtime_llm',
    evaluatedAt: new Date().toISOString(),
    evaluationVersion: CLAIM_EVALUATION_VERSION,
    evidenceCounts: prior?.evidenceCounts || {},
  };
}

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
  const schemaV3 = Array.isArray(artifacts.claims) && artifacts.claims.length > 0;
  const claims = (schemaV3 ? artifacts.claims : extractClaims(artifacts.report))
    .map((claim) => normalizeClaim(claim, {
      origin: schemaV3 ? 'stored_rule' : 'runtime_rule',
      preserveEvaluation: schemaV3,
    }));
  const artifactsHealth = summarizeFindingsHealth(artifacts.findings, artifacts.sources);
  const claimResults = [];
  let llmInvoked = false;

  for (const claim of claims) {
    const rule = schemaV3
      ? schemaV3Rule(claim, artifacts, strictPlatform)
      : scoreClaimRule(claim, citationMap, { strictPlatform });
    const ruleEvaluation = schemaV3 ? storedEvaluation(claim) : evaluationFromLegacyRule(claim, rule);
    let llmResult = null;
    let effectiveEvaluation = ruleEvaluation;

    if (llmEnabled && llm && ['key_claim', 'supporting_claim'].includes(claim.kind)) {
      llmResult = await judgeClaimWithLlm(claim, rule, llm);
      if (!llmResult.skipped) {
        llmInvoked = true;
        effectiveEvaluation = runtimeLlmEvaluation(llmResult, ruleEvaluation);
      }
    }

    claimResults.push({
      claim,
      rule,
      ruleVerdict: ruleEvaluation.verdict,
      llmVerdict: llmResult?.skipped ? null : (llmResult?.verdict || null),
      effectiveVerdict: effectiveEvaluation.verdict,
      evaluationOrigin: effectiveEvaluation.origin,
      evaluationVersion: effectiveEvaluation.evaluationVersion || CLAIM_EVALUATION_VERSION,
      effectiveEvaluation,
      llm: llmResult,
    });
  }

  const result = aggregateBenchmark({
    meta: artifacts.meta,
    artifactsHealth,
    claimResults,
    llmEnabled: llmEnabled && Boolean(llm),
    llmInvoked,
  });
  const sourceHosts = new Set(artifacts.sources.map((source) => {
    try { return new URL(source.url).hostname; } catch { return ''; }
  }).filter(Boolean));
  result.metrics.sourceHostCount = sourceHosts.size;
  result.metrics.passageCount = artifacts.passages?.length || 0;
  result.metrics.averageSourcesPerClaim = result.metrics.evaluatedClaimCount
    ? Number((claims
      .filter((claim) => ['key_claim', 'supporting_claim'].includes(claim.kind))
      .reduce((sum, claim) => sum + new Set((claim.evidence || []).map((entry) => entry.sourceId)).size, 0)
      / result.metrics.evaluatedClaimCount).toFixed(4))
    : null;
  return result;
}
