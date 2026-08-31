import { generateQuestions } from '../question-generator.mjs';
import { searchQuestion } from '../search-executor.mjs';
import { enrichFindings } from '../source-enricher.mjs';
import { resolveFocusedSettings } from '../focused-settings.mjs';
import { filterFindingsByRelevance } from '../source-relevance-filter.mjs';
import { applySourceSelection } from '../source-candidates.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';
import { inferResearchProfile, planResearchProfile } from '../adaptive/research-profile.mjs';
import { evaluateReadinessGate, repairGapsFromGate } from '../adaptive/readiness-gate.mjs';
import { isMaterialGap } from '../gap-state.mjs';
import { normalizeSourceUrl } from '../source-candidates.mjs';

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

async function enrichWave(findings, context, focused) {
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
  const enriched = focused.fetchMode === 'disabled'
    ? merged
    : await enrichFindings(merged, {
      query: context.query,
      fetchMode: focused.fetchMode,
      maxUrlsPerIteration: focused.maxUrlsPerIteration,
      maxUrlsTotal: focused.maxUrlsTotal,
      maxContentChars: focused.maxContentChars,
      enrichConcurrency: focused.enrichConcurrency,
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

function syncState(state, findings) {
  state.findings = findings;
  state.syncGapCoverage();
  return evaluateReadinessGate({
    query: state.query,
    findings,
    gaps: state.gaps,
    profile: state.profile,
    state,
  });
}

function waveMetrics(beforeUrls, findings, gapsBefore, gaps) {
  const urls = new Set(findings.flatMap((finding) => finding.sources || []).map(canonicalUrl).filter(Boolean));
  const closedBefore = new Set(gapsBefore.filter((gap) => gap.status === 'verified').map((gap) => gap.id));
  const closed = gaps.filter((gap) => gap.status === 'verified' && !closedBefore.has(gap.id)).length;
  const totalSources = findings.reduce((sum, finding) => sum + (finding.sources || []).length, 0);
  return {
    newIndependentSources: Math.max(0, urls.size - beforeUrls.size),
    duplicateResultRatio: totalSources ? Math.max(0, (totalSources - urls.size) / totalSources) : 0,
    materialGapsClosed: closed,
    plateau: urls.size <= beforeUrls.size && closed === 0,
  };
}

/**
 * Focused pipeline with optional URL enrichment, source selection, and early-stop.
 *
 * @param {import('../../types.mjs').StrategyContext} context
 */
export async function runFocusedPipeline(context) {
  const {
    query,
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
    researchProviders,
  } = context;

  const focused = resolveFocusedSettings(settings);
  let profile = inferResearchProfile(context.brief || query, { settings, depth: 'focused' });
  profile = await planResearchProfile({ llm, query, profile, signal, settings });
  const brief = profile.brief;
  addTrace(trace, 'research_brief_sanitized', {
    reasonCode: 'planner_output_validated',
    brief,
  });
  const state = new ResearchState({ query, profile, brief, settings, budget });
  const plannedSlots = brief.requiredAnswerSlots.length
    ? brief.requiredAnswerSlots
    : (profile.plannedGaps || []);
  if (!plannedSlots.length) {
    emit({ stage: 'generating_questions', iteration: 1, iterations: 2 });
    const questions = await generateQuestions({ llm, query, count: questionCount, signal, mode: 'initial' });
    plannedSlots.push(...questions.map((question) => ({ question, answerSlot: question, priority: 'normal' })));
  }
  for (const slot of plannedSlots) {
    if (state.gaps.length >= Math.max(2, questionCount + 1)) break;
    state.addGap(slot.question || slot.answerSlot, slot.priority || 'normal', {
      answerSlot: slot.answerSlot,
      claimFamily: slot.claimFamily,
      requiredHosts: slot.requiredHosts,
      requiredSourceTypes: slot.requiredSourceTypes,
    });
  }

  let findings = [];
  const executeWave = async (wave, targets, queryFor = (gap) => gap.question) => {
    const waveQueries = targets.map((gap) => ({ gap, query: queryFor(gap) })).filter((item) => item.query);
    emit({ stage: 'searching', iteration: wave === 'discovery' ? 1 : 2, iterations: 2, total: waveQueries.length });
    addTrace(trace, 'search_wave_started', {
      reasonCode: wave,
      wave,
      targetGapIds: targets.map((gap) => gap.id),
      queries: waveQueries.map((item) => item.query),
    });
    const searched = await runBounded(waveQueries, concurrency, async ({ gap, query: searchQuery }) => {
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
    });
    const selected = applySourceSelection(searched, focused.sourceSelection);
    emit({ stage: 'enriching_sources', iteration: wave === 'discovery' ? 1 : 2, iterations: 2 });
    const enriched = await enrichWave(selected, context, focused);
    findings.push(...enriched);
    addTrace(trace, 'search_wave_merged', {
      reasonCode: `${wave}_merge`,
      wave,
      findingCount: enriched.length,
      sourceCount: enriched.reduce((sum, finding) => sum + (finding.sources || []).length, 0),
    });
  };

  const discoveryTargets = state.gaps;
  await executeWave('discovery', discoveryTargets);
  let gate = syncState(state, findings);
  addTrace(trace, 'readiness_gate', {
    reasonCode: gate.pass ? 'evidence_sufficient' : 'repair_required',
    strategy: 'focused',
    failures: gate.failures,
  });

  const gapsBeforeRepair = state.gaps.map((gap) => ({ ...gap }));
  const urlsBeforeRepair = new Set(findings.flatMap((finding) => finding.sources || []).map(canonicalUrl).filter(Boolean));
  const repairTargets = repairGapsFromGate(gate, state.gaps).filter(isMaterialGap);
  if (!gate.pass && repairTargets.length && (!budget || budget.canClaim('searchRequests'))) {
    for (const gap of repairTargets) gap.nextQueries = [gapQuery(gap, query)];
    await executeWave('repair', repairTargets, (gap) => gap.nextQueries[0]);
    gate = syncState(state, findings);
  }
  const marginal = waveMetrics(urlsBeforeRepair, findings, gapsBeforeRepair, state.gaps);
  addTrace(trace, 'plateau_evaluated', {
    reasonCode: marginal.plateau ? 'focused_plateau' : 'focused_novelty',
    ...marginal,
  });

  const challengeTargets = state.gaps.filter((gap) => (
    gap.priority === 'critical'
    || brief.consequentialClaims.some((claim) => (
      gap.question.includes(claim) || claim.includes(gap.answerSlot || gap.question)
    ))
  )).slice(0, focused.challenge.maxClaims);
  if (focused.challenge.enabled && challengeTargets.length && (!budget || budget.canClaim('searchRequests'))) {
    await executeWave('challenge', challengeTargets, (gap) => gapQuery(gap, query, 'challenge'));
    gate = syncState(state, findings);
    addTrace(trace, 'challenge_completed', {
      reasonCode: 'bounded_consequential_claim_challenge',
      targetGapIds: challengeTargets.map((gap) => gap.id),
      queryCount: challengeTargets.length,
    });
  }

  const spotCheckGap = challengeTargets[0] || state.gaps.find((gap) => gap.priority === 'critical');
  if (spotCheckGap) {
    const bodySource = findings
      .filter((finding) => finding.gapId === spotCheckGap.id)
      .flatMap((finding) => finding.sources || [])
      .find((source) => source.fetchStatus === 'ok' && source.content);
    addTrace(trace, 'claim_spot_check', {
      reasonCode: bodySource ? 'direct_source_confirmed' : 'direct_source_missing',
      targetGapIds: [spotCheckGap.id],
      sourceId: bodySource?.id || bodySource?.url || null,
      passed: Boolean(bodySource),
    });
  }

  addTrace(trace, 'focused_stop_decision', {
    reasonCode: gate.pass ? 'evidence_sufficient' : (marginal.plateau ? 'plateau_with_open_gaps' : 'budget_or_wave_limit'),
    readinessPass: gate.pass,
    plateau: marginal.plateau,
    failures: gate.failures,
  });

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
    marginal,
  });
}
