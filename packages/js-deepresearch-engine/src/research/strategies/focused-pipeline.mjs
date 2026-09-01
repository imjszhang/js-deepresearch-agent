import { searchQuestion } from '../search-executor.mjs';
import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { resolveReadSettings } from '../read-settings.mjs';
import { filterFindingsByRelevance } from '../source-relevance-filter.mjs';
import { applySourceSelection } from '../source-candidates.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';
import { evaluateReadinessGate, repairGapsFromGate } from '../adaptive/readiness-gate.mjs';
import { isMaterialGap } from '../gap-state.mjs';
import { applySlotSupportJudgments, judgeOpenSlotSupport } from '../gap-slot-support.mjs';
import { normalizeSourceUrl } from '../source-candidates.mjs';
import { resolveStrategyConcurrency } from '../strategy-utils.mjs';
import { applyContractGaps, planAndNormalizeContract } from '../research-contract.mjs';
import { isSuccessfulBody } from '../body-quality.mjs';

function addTrace(trace, action, fields = {}) {
  trace.push({
    step: trace.length + 1,
    action,
    ...fields,
    createdAt: new Date().toISOString(),
  });
}

async function runBounded(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const width = Math.min(Math.max(1, Number(concurrency) || 1), items.length);
  await Promise.all(Array.from({ length: width }, consume));
  return results;
}

function attachControl(findings, control) {
  Object.defineProperties(findings, {
    researchBrief: { value: control.brief, enumerable: false, configurable: true },
    researchControl: { value: control, enumerable: false, configurable: true },
  });
  return findings;
}

function gapQuery(gap, query, kind = 'repair') {
  const missing = (gap.missingEvidence || []).join(' ');
  const hosts = (gap.requiredHosts || []).map((host) => `site:${host}`).join(' ');
  if (gap.status === 'conflicting') return `${gap.question} conflicting evidence correction different definition date denominator`;
  if (kind === 'challenge') return `${gap.question || query} counterexample failure correction alternative explanation`;
  return [gap.question || query, hosts, missing, 'primary source evidence'].filter(Boolean).join(' ');
}

function canonicalUrl(source) {
  return normalizeSourceUrl(source?.url) || source?.url || source?.id || '';
}

function normalizeClaimKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesConsequentialClaim(gap, claims = []) {
  const keys = [gap.answerSlot, gap.question, gap.claimFamily].map(normalizeClaimKey).filter(Boolean);
  return claims.some((claim) => keys.includes(normalizeClaimKey(claim)));
}

async function enrichWave(findings, context, focused, readPolicy) {
  const byUrl = new Map();
  for (const finding of findings) {
    for (const source of finding.sources || []) {
      const key = canonicalUrl(source);
      if (key && !byUrl.has(key)) byUrl.set(key, source);
    }
  }
  const merged = [{
    question: context.query,
    sources: [...byUrl.values()],
  }];
  const enriched = readPolicy.fetchMode === 'disabled'
    ? merged
    : await enrichFindings(merged, {
      query: context.query,
      fetchMode: readPolicy.fetchMode,
      maxUrlsPerIteration: focused.maxUrlsPerIteration,
      maxUrlsTotal: focused.maxUrlsTotal,
      maxContentChars: readPolicy.maxContentChars,
      enrichConcurrency: readPolicy.enrichConcurrency,
      llm: context.llm,
      signal: context.signal,
      settings: context.settings,
      budget: context.budget,
      embedding: context.researchProviders?.embedding,
    });
  const enrichedByUrl = new Map((enriched[0]?.sources || []).map((source) => [canonicalUrl(source), source]));
  return findings.map((finding) => ({
    ...finding,
    sources: (finding.sources || []).map((source) => enrichedByUrl.get(canonicalUrl(source)) || source),
  }));
}

async function syncState(state, findings, { llm, signal, query, trace } = {}) {
  state.findings = findings;
  state.syncGapCoverage();
  const support = await judgeOpenSlotSupport({
    llm,
    signal,
    query: query || state.query,
    gaps: state.gaps,
    findings,
  });
  applySlotSupportJudgments(state.gaps, support.judgments);
  state.syncGapCoverage();
  if (trace && support.judgments.length) {
    addTrace(trace, 'slot_support', {
      reasonCode: support.unknown ? 'slot_support_unknown' : 'slot_support_judged',
      unknown: support.unknown,
      retried: support.retried,
      gapIds: support.judgments.map((item) => item.gapId).filter(Boolean),
    });
  }
  return evaluateReadinessGate({
    query: state.query,
    findings,
    gaps: state.gaps,
    profile: state.profile,
    state,
  });
}

function bodyUrlsFromFindings(findings = []) {
  return new Set(
    findings
      .flatMap((finding) => finding.sources || [])
      .filter(isSuccessfulBody)
      .map(canonicalUrl)
      .filter(Boolean),
  );
}

function waveMetrics(beforeBodyUrls, findings, gapsBefore, gaps) {
  const urls = new Set(findings.flatMap((finding) => finding.sources || []).map(canonicalUrl).filter(Boolean));
  const bodyUrls = bodyUrlsFromFindings(findings);
  const closedBefore = new Set(gapsBefore.filter((gap) => gap.status === 'verified').map((gap) => gap.id));
  const closed = gaps.filter((gap) => gap.status === 'verified' && !closedBefore.has(gap.id)).length;
  const totalSources = findings.reduce((sum, finding) => sum + (finding.sources || []).length, 0);
  return {
    newIndependentSources: Math.max(0, bodyUrls.size - beforeBodyUrls.size),
    duplicateResultRatio: totalSources ? Math.max(0, (totalSources - urls.size) / totalSources) : 0,
    materialGapsClosed: closed,
    plateau: bodyUrls.size <= beforeBodyUrls.size && closed === 0,
  };
}

function searchableGaps(state) {
  return state.gaps.filter((gap) => !gap.rollup);
}

function criticalGapsRemain(gaps = []) {
  return gaps.some((gap) => (
    !gap.rollup
    && gap.priority === 'critical'
    && ['open', 'searched', 'missing', 'conflicting', 'limited', 'blocked'].includes(gap.status)
  ));
}

/**
 * Focused pipeline with discovery, optional repair waves, and bounded challenge.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 */
export async function runFocusedPipeline(context) {
  const {
    query,
    iterations,
    questionCount,
    concurrency,
    llm,
    search,
    signal,
    emit,
    settings,
    budget,
    queryMemory,
    trace = [],
  } = context;

  const focused = resolveFocusedSettings(settings);
  const readPolicy = resolveReadSettings(settings, { strategy: 'focused' });
  const contract = await planAndNormalizeContract({
    llm,
    query,
    incomingBrief: context.brief,
    settings,
    signal,
    depth: 'focused',
  });
  const { profile, brief, slots } = contract;
  addTrace(trace, 'research_brief_sanitized', {
    reasonCode: contract.contractUnavailable ? 'contract_unavailable' : 'planner_output_validated',
    brief,
    contractOrigin: brief.contractOrigin,
    contractRetried: contract.contractRetried,
    contractFailure: contract.contractFailure,
  });
  const state = new ResearchState({ query, profile, brief, settings, budget });
  if (contract.contractUnavailable) {
    const gate = evaluateReadinessGate({
      query,
      findings: [],
      gaps: state.gaps,
      profile,
      state,
    });
    addTrace(trace, 'focused_stop_decision', {
      reasonCode: 'contract_unavailable',
      readinessPass: false,
      failures: gate.failures,
    });
    budget?.setControllerStopReason?.('contract_unavailable');
    return attachControl([], {
      schemaVersion: 1,
      brief,
      profile,
      gaps: state.gaps,
      readiness: gate,
      contractUnavailable: true,
      marginal: {
        newIndependentSources: 0,
        duplicateResultRatio: 0,
        materialGapsClosed: 0,
        plateau: false,
      },
    });
  }
  applyContractGaps(state, contract, {
    maxGaps: Math.max(slots.length + 1, questionCount + 1),
  });

  let findings = [];
  const executeWave = async (wave, targets, queryFor = (gap) => gap.question) => {
    const waveQueries = targets.map((gap) => ({ gap, query: queryFor(gap) })).filter((item) => item.query);
    const resolvedConcurrency = resolveStrategyConcurrency(search, concurrency, waveQueries.length);
    emit({
      stage: 'searching',
      iteration: wave === 'discovery' ? 1 : 2,
      iterations: 2,
      total: waveQueries.length,
    });
    addTrace(trace, 'search_wave_started', {
      reasonCode: wave,
      wave,
      targetGapIds: targets.map((gap) => gap.id),
      queries: waveQueries.map((item) => item.query),
    });
    const searched = await runBounded(waveQueries, resolvedConcurrency, async ({ gap, query: searchQuery }) => {
      try {
        const result = await searchQuestion({
          question: searchQuery,
          search,
          signal,
          queryMemory,
          gapId: gap.id,
          onSkip: ({ question }) => emit({ stage: 'query_skipped_duplicate', question }),
        });
        state.recordSearchedQuery(gap.id, searchQuery);
        gap.nextQueries = [];
        return { ...result, question: gap.question, gapId: gap.id, wave };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        state.recordSearchedQuery(gap.id, searchQuery);
        return {
          question: gap.question,
          gapId: gap.id,
          wave,
          sources: [],
          error: { name: error?.name || 'Error', message: error?.message || String(error) },
        };
      }
    });
    const selected = applySourceSelection(searched, focused.sourceSelection);
    emit({ stage: 'enriching_sources', iteration: wave === 'discovery' ? 1 : 2, iterations: 2 });
    const enriched = await enrichWave(selected, context, focused, readPolicy);
    findings.push(...enriched);
    addTrace(trace, 'search_wave_merged', {
      reasonCode: `${wave}_merge`,
      wave,
      findingCount: enriched.length,
      sourceCount: enriched.reduce((sum, finding) => sum + (finding.sources || []).length, 0),
    });
    return enriched;
  };

  await executeWave('discovery', searchableGaps(state));
  let gate = await syncState(state, findings, { llm, signal, query, trace });
  addTrace(trace, 'readiness_gate', {
    reasonCode: gate.pass ? 'evidence_sufficient' : 'repair_required',
    strategy: 'focused',
    failures: gate.failures,
  });

  const iterationLimit = focused.iterationControl.enabled
    ? Math.max(focused.iterationControl.minIterations, focused.iterationControl.maxIterations)
    : Math.max(1, Number(iterations) || 1);
  const minIterations = focused.iterationControl.enabled
    ? focused.iterationControl.minIterations
    : 1;

  let consecutiveLowYield = 0;
  let latestMarginal = {
    newIndependentSources: 0,
    duplicateResultRatio: 0,
    materialGapsClosed: 0,
    plateau: false,
  };

  for (let waveIndex = 2; waveIndex <= iterationLimit; waveIndex += 1) {
    if (waveIndex > minIterations && focused.iterationControl.earlyStop && gate.pass) break;
    if (
      focused.iterationControl.enabled
      && !focused.iterationControl.continueOnCriticalGaps
      && criticalGapsRemain(state.gaps)
    ) {
      break;
    }
    if (budget && !budget.canClaim('searchRequests')) break;
    if (focused.plateau.enabled && consecutiveLowYield >= focused.plateau.maxLowYieldWaves) {
      addTrace(trace, 'plateau_evaluated', {
        reasonCode: 'focused_plateau_stop',
        ...latestMarginal,
        consecutiveLowYield,
      });
      break;
    }

    const repairTargets = repairGapsFromGate(gate, state.gaps).filter(isMaterialGap);
    if (!repairTargets.length) break;
    for (const gap of repairTargets) gap.nextQueries = [gapQuery(gap, query)];
    const gapsBeforeRepair = state.gaps.map((gap) => ({ ...gap }));
    const bodyUrlsBeforeRepair = bodyUrlsFromFindings(findings);
    await executeWave('repair', repairTargets, (gap) => gap.nextQueries[0]);
    gate = await syncState(state, findings, { llm, signal, query, trace });
    latestMarginal = waveMetrics(bodyUrlsBeforeRepair, findings, gapsBeforeRepair, state.gaps);
    consecutiveLowYield = latestMarginal.plateau ? consecutiveLowYield + 1 : 0;
    addTrace(trace, 'plateau_evaluated', {
      reasonCode: latestMarginal.plateau ? 'focused_plateau' : 'focused_novelty',
      ...latestMarginal,
      consecutiveLowYield,
    });
  }

  const challengeTargets = focused.challenge.enabled
    ? state.gaps.filter((gap) => !gap.rollup && matchesConsequentialClaim(gap, brief.consequentialClaims))
      .slice(0, focused.challenge.maxClaims)
    : [];
  if (challengeTargets.length && (!budget || budget.canClaim('searchRequests'))) {
    await executeWave('challenge', challengeTargets, (gap) => gapQuery(gap, query, 'challenge'));
    gate = await syncState(state, findings, { llm, signal, query, trace });
    addTrace(trace, 'challenge_completed', {
      reasonCode: 'bounded_consequential_claim_challenge',
      targetGapIds: challengeTargets.map((gap) => gap.id),
      queryCount: challengeTargets.length,
    });
  }

  const spotCheckGap = challengeTargets[0] || null;
  if (spotCheckGap) {
    const bodySource = findings
      .filter((finding) => finding.wave === 'challenge' && finding.gapId === spotCheckGap.id)
      .flatMap((finding) => finding.sources || [])
      .find((source) => source.fetchStatus === 'ok' && source.content);
    addTrace(trace, 'claim_spot_check', {
      reasonCode: bodySource ? 'direct_source_confirmed' : 'direct_source_missing',
      targetGapIds: [spotCheckGap.id],
      sourceId: bodySource?.id || bodySource?.url || null,
      passed: Boolean(bodySource),
    });
  }

  const stopReason = gate.pass ? 'evidence_sufficient' : 'budget_exhausted';
  addTrace(trace, 'focused_stop_decision', {
    reasonCode: gate.pass ? 'evidence_sufficient' : (latestMarginal.plateau ? 'plateau_with_open_gaps' : 'budget_or_wave_limit'),
    readinessPass: gate.pass,
    plateau: latestMarginal.plateau,
    failures: gate.failures,
    stopReason,
  });
  budget?.setControllerStopReason?.(stopReason);

  if (focused.enableRelevanceFilter) {
    emit({ stage: 'filtering_sources' });
    findings = await filterFindingsByRelevance(findings, {
      query,
      llm,
      signal,
      enabled: true,
      maxSourcesForReport: focused.maxSourcesForReport,
    });
  }
  return attachControl(findings, {
    schemaVersion: 1,
    brief,
    profile,
    gaps: state.gaps,
    readiness: gate,
    marginal: latestMarginal,
  });
}
