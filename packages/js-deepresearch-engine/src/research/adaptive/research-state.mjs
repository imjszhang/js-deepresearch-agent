import { createHash } from 'node:crypto';
import { ActionCostTracker, buildBudgetView, estimateReportPromptTokens } from './budget-view.mjs';
import {
  evaluateExploratorySufficiency,
  similarQuestions,
  sourceHasBody,
} from './exploratory-sufficiency.mjs';
import { createGapRecord, createRootGap, inferResearchProfile } from './research-profile.mjs';
import { evaluateReadinessGate } from './readiness-gate.mjs';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  hostnameOf as policyHostnameOf,
  hostnamesMatch,
  inferEvidenceScope,
  requiredHostCoverage,
  registrableDomainFromUrl,
  selectReadsByPolicy,
} from './source-policy.mjs';
import { sourceDiversityKey } from '../source-candidates.mjs';
import { UrlPool } from './url-pool.mjs';
import { collectGapSources, evaluateGapEvidence, rollupRootGap } from '../gap-state.mjs';
import { compactSearchSnippets, getSearchMeta } from '../../search/search-result.mjs';
import { inferSearchOutcome } from '../search-trace.mjs';
import { serializeSearchError } from '../../search/search-provider-error.mjs';
import { isExternalRerankProvider } from './source-policy.mjs';

export { hostnameOf } from './source-policy.mjs';

export function candidateContentFingerprint(source = {}) {
  return createHash('sha256')
    .update([source.title, source.snippet, source.summary, source.content].map((part) => String(part || '')).join('\n'))
    .digest('hex');
}

export function rerankEvaluationKey(gapId, sourceId, fingerprint, model) {
  return `${gapId}\0${sourceId}\0${fingerprint}\0${model || ''}`;
}

const ACTIONS = new Set(['search', 'read', 'reflect', 'draft', 'finalize', 'answer', 'stop']);
const FINALIZE_ACTIONS = new Set(['draft', 'finalize', 'answer', 'stop']);
const RANKED_CANDIDATE_LIMIT = 20;
const SNAPSHOT_CANDIDATE_LIMIT = 8;
const MAX_CANDIDATES_PER_HOSTNAME = 2;
const KNOWLEDGE_SNIPPET_CHARS = 160;
const DIARY_SNAPSHOT_LINES = 12;

const BOOST_HOSTNAME_PATTERNS = [
  /(^|\.)github\.com$/,
  /(^|\.)gitlab\.com$/,
  /\.readthedocs\.io$/,
  /^docs\./,
  /(^|\.)wikipedia\.org$/,
];
const PENALIZE_HOSTNAME_PATTERNS = [
  /(^|\.)softonic\.com$/,
  /(^|\.)cnet\.com$/,
  /(^|\.)mcafee\.com$/,
  /^apps\.microsoft\.com$/,
  /^play\.google\.com$/,
  /(^|\.)amazon\.[a-z.]+$/,
  /(^|\.)techspot\.com$/,
];
const HOSTNAME_BOOST = 0.3;
const HOSTNAME_PENALTY = -0.6;

export function hostnameWeight(url) {
  const hostname = policyHostnameOf(url);
  if (!hostname) return 0;
  if (PENALIZE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_PENALTY;
  if (BOOST_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_BOOST;
  return 0;
}

function normalizeAction(action) {
  if (action === 'answer') return 'finalize';
  if (action === 'stop') return 'finalize';
  return action;
}

export class ResearchState {
  constructor({
    query,
    maxSteps = 0,
    maxGapDepth = 2,
    minLlmTokens = 0,
    targetLlmTokens = 0,
    budget = null,
    profile = null,
    settings = null,
    evidenceScope = null,
    brief = null,
  } = {}) {
    this.query = query;
    this.settings = settings || {};
    this.evidenceScope = evidenceScope || profile?.evidenceScope || inferEvidenceScope(this.settings);
    const parsedSteps = Number(maxSteps);
    this.maxSteps = Number.isFinite(parsedSteps) && parsedSteps > 0 ? Math.floor(parsedSteps) : 0;
    this.maxGapDepth = Math.max(0, Number(maxGapDepth) || 0);
    this.minLlmTokens = Number(minLlmTokens || targetLlmTokens) || 0;
    this.targetLlmTokens = this.minLlmTokens;
    this.budgetManager = budget;
    this.actionCosts = new ActionCostTracker();
    this.budgetView = null;
    this.sufficiency = null;
    this.readiness = null;
    this.profile = profile || inferResearchProfile(query, {
      settings: this.settings,
      evidenceScope: this.evidenceScope,
    });
    this.brief = brief || this.profile?.brief || null;
    this.step = 0;
    this.lastAction = null;
    this.gaps = [createRootGap(query, this.profile)];
    this.findings = [];
    this.candidates = new Map();
    this.urlPool = new UrlPool({ maxPerHostname: MAX_CANDIDATES_PER_HOSTNAME });
    this.readSourceIds = new Set();
    this.observedHosts = new Set();
    this.knowledge = [];
    this.observations = [];
    this.diary = [];
    this.evaluationRetries = 0;
    this.forbidFinalizeUntilExplore = false;
    this.forbidSearchUntilRead = false;
    this.embeddingTraces = [];
    this.marginal = {
      consecutiveLowNoveltyReads: 0,
      duplicateQueryCount: 0,
      duplicateResultCount: 0,
      searchCount: 0,
      recentNewIndependentSources: 0,
      recentMaterialGapsClosed: 0,
      plateau: false,
    };
    this.relevance = {
      returnedCandidates: 0,
      siteRejected: 0,
      admittedCandidates: 0,
      rerankEvaluated: 0,
      rerankAccepted: 0,
      rerankRejected: 0,
      rerankCalls: 0,
      uniqueGapCandidateEvaluations: 0,
      cacheHits: 0,
      rerankMissingResults: 0,
      bodyIrrelevant: 0,
      readAccepted: 0,
    };
    this.recovery = {
      invalidSteps: 0,
      recoveryRounds: 0,
      duplicateQueryRejections: 0,
      siteFilteredAllQueries: 0,
      siteFallbackQueries: 0,
      plannerRejectedQueries: 0,
      plannerRetryCount: 0,
      plannerFailures: 0,
      lastPlannerFailure: null,
      relevanceRejectedStreak: 0,
      transientFailures: 0,
      providerRetries: 0,
      transientStreak: 0,
      duplicateStreak: 0,
      semanticNoYieldStreak: 0,
    };
    this.rerankCache = new Map();
    this.cycle = {
      afterSearch: false,
      successfulBodyReads: 0,
      newUrlCount: 0,
      lastSearchQuery: null,
    };
    this.searchOutcomes = [];
    this.plannerRejections = [];
    this.slotSupportCache = new Map();
    this.lastAgentSnapshotChars = null;
  }

  addDiary(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.diary.push(`step ${this.step}: ${text}`);
  }

  addGap(question, priority = 'normal', options = {}) {
    const text = String(question || '').trim();
    if (!text) return null;
    if (options.deduplicate !== false
      && this.gaps.some((gap) => !gap.rollup && similarQuestions(gap.question, text))) return null;
    const nextDepth = options.depth ?? 1;
    if (this.maxGapDepth > 0 && nextDepth > this.maxGapDepth) return null;
    const gap = createGapRecord({
      id: options.id || `gap-${this.gaps.length + 1}`,
      question: text,
      priority,
      depth: nextDepth,
      profile: this.profile,
      requiredHosts: options.requiredHosts,
      requiredHostMode: options.requiredHostMode,
      preferredHosts: options.preferredHosts,
      requiredSourceTypes: options.requiredSourceTypes,
      minIndependentSources: options.minIndependentSources,
      contractSlotId: options.contractSlotId,
      answerSlot: options.answerSlot,
      claimFamily: options.claimFamily,
      requiredSlot: options.requiredSlot,
      kind: options.kind,
      rollup: options.rollup,
      evidenceCriteria: options.evidenceCriteria,
    });
    this.gaps.push(gap);
    return gap;
  }

  getGap(gapId) {
    return this.gaps.find((gap) => gap.id === gapId) || this.gaps[0];
  }

  gapNeedsPrimaryEvidence(gap = this.gaps[0]) {
    return Boolean(
      gap?.requiredHosts?.length
      || (gap?.requiredSourceTypes || []).includes('primary_filing'),
    );
  }

  sourceSatisfiesPrimary(source, gap) {
    if (!sourceHasBody(source)) return false;
    const needsFiling = (gap?.requiredSourceTypes || []).includes('primary_filing');
    const tier = source.tier || classifySourceTier(source, gap);
    if (needsFiling && !['required_primary', 'other_primary'].includes(tier)) return false;
    if (needsFiling && !documentMatchesQuerySubject(source, this.query, {
      entities: this.brief?.entities || this.profile?.brief?.entities || [],
      entityAliases: this.brief?.entityAliases || this.profile?.brief?.entityAliases || [],
    })) return false;
    if (gap?.requiredHosts?.length) {
      return gap.requiredHosts.some((host) => hostnamesMatch(policyHostnameOf(source.url || source.id), host));
    }
    return !needsFiling || ['required_primary', 'other_primary'].includes(tier);
  }

  gapCovered(gapId) {
    const gap = this.getGap(gapId);
    if (gap && ['verified', 'resolved'].includes(gap.status)) return true;
    if (this.gapNeedsPrimaryEvidence(gap) && !this.gapHasRequiredHostBody(gapId)) return false;
    return this.findings.some((finding) => finding.gapId === gapId
      && (finding.sources || []).some(sourceHasBody));
  }

  gapHasRequiredHostBody(gapId) {
    const gap = this.getGap(gapId);
    if (!this.gapNeedsPrimaryEvidence(gap)) return true;
    const sources = this.findings
      .filter((finding) => finding.gapId === gapId)
      .flatMap((finding) => (finding.sources || []).filter(sourceHasBody));
    const hostsSatisfied = requiredHostCoverage(sources, gap).satisfied;
    const primarySatisfied = !(gap.requiredSourceTypes || []).includes('primary_filing')
      || sources.some((source) => this.sourceSatisfiesPrimary(source, { ...gap, requiredHosts: [] }));
    return hostsSatisfied && primarySatisfied;
  }

  hasBodyEvidence() {
    return this.findings.some((finding) => (finding.sources || []).some(sourceHasBody));
  }

  cycleHasSuccessfulBody() {
    return this.cycle.successfulBodyReads > 0;
  }

  beginSearchCycle() {
    this.cycle.afterSearch = true;
    this.cycle.successfulBodyReads = 0;
    this.cycle.newUrlCount = 0;
  }

  noteSuccessfulBody() {
    this.cycle.successfulBodyReads += 1;
    this.forbidSearchUntilRead = false;
  }

  noteReadNovelty(novel) {
    this.marginal.consecutiveLowNoveltyReads = novel
      ? 0
      : this.marginal.consecutiveLowNoveltyReads + 1;
    this.marginal.plateau = this.marginal.consecutiveLowNoveltyReads >= 2
      || (this.marginal.searchCount >= 2
        && this.marginal.recentNewIndependentSources === 0
        && this.marginal.recentMaterialGapsClosed === 0);
  }

  noteSearchYield({ duplicateResults = false, newUrls = 0 } = {}) {
    this.marginal.searchCount += 1;
    if (duplicateResults) {
      this.marginal.duplicateResultCount += 1;
      this.noteDuplicateQuery();
    }
    this.marginal.recentNewIndependentSources = Number(newUrls) || 0;
    this.marginal.plateau = this.marginal.consecutiveLowNoveltyReads >= 2
      || (this.marginal.searchCount >= 2
        && this.marginal.recentNewIndependentSources === 0
        && this.marginal.recentMaterialGapsClosed === 0);
  }

  noteDuplicateQuery() {
    this.marginal.duplicateQueryCount += 1;
    this.recovery.duplicateQueryRejections += 1;
  }

  syncGapCoverage() {
    const verifiedBefore = new Set(this.gaps.filter((gap) => gap.status === 'verified').map((gap) => gap.id));
    for (const gap of this.gaps) {
      const sources = collectGapSources(gap, this.findings);
      gap.readSourceIds = [...new Set([
        ...(gap.readSourceIds || []),
        ...sources.map((source) => source.id || source.url).filter(Boolean),
      ])];
      if (gap.status === 'missing') continue;
      if (gap.status === 'blocked' && !sources.length) continue;
      Object.assign(gap, evaluateGapEvidence(gap, sources, {
        passageIds: this.findings
          .filter((finding) => finding.gapId === gap.id)
          .flatMap((finding) => finding.passageIds || []),
        slotSupport: gap.slotSupport,
        entities: this.brief?.entities || this.profile?.brief?.entities || [],
        entityAliases: this.brief?.entityAliases || this.profile?.brief?.entityAliases || [],
        query: this.query,
      }));
      if (gap.status === 'verified') gap.resolvedAtStep = this.step;
    }
    rollupRootGap(this.gaps);
    this.marginal.recentMaterialGapsClosed = this.gaps.filter((gap) => (
      gap.status === 'verified' && !verifiedBefore.has(gap.id)
    )).length;
  }

  markGapStatus(gapId, status, reason = null) {
    const gap = this.getGap(gapId);
    if (!gap) return;
    gap.status = status;
    if (reason) gap.blockedReason = reason;
  }

  recordSearchedQuery(gapId, query) {
    const gap = this.getGap(gapId);
    if (!gap || !query) return;
    if (!gap.searchedQueries.includes(query)) gap.searchedQueries.push(query);
    if (gap.status === 'open') gap.status = 'searched';
  }

  recordPlannerRejections(rejected = [], extra = {}) {
    for (const item of rejected || []) {
      const query = String(item?.query || item || '').trim();
      if (!query) continue;
      this.plannerRejections.push({
        query,
        reason: item.reason || 'rejected',
        duplicateOf: item.duplicateOf || null,
        step: this.step,
        plannerMode: extra.plannerMode || item.plannerMode || null,
      });
    }
  }

  recordSearchOutcome(partial = {}) {
    const meta = partial.searchMeta || getSearchMeta(partial.sources) || {};
    const accepted = partial.resultCount == null ? (partial.sources?.length || 0) : partial.resultCount;
    const returned = partial.returnedResultCount == null ? (partial.sources?.length || 0) : partial.returnedResultCount;
    const record = {
      query: String(partial.query || '').trim(),
      queryOrigin: partial.queryOrigin || null,
      plannerMode: partial.plannerMode || null,
      gapId: partial.gapId || null,
      searchOptions: partial.searchOptions || meta.effectiveSearchOptions || meta.requestParams || null,
      requestedSearchOptions: partial.requestedSearchOptions || meta.requestedSearchOptions || null,
      effectiveSearchOptions: partial.effectiveSearchOptions || meta.effectiveSearchOptions || null,
      droppedSearchOptions: partial.droppedSearchOptions || meta.droppedSearchOptions || [],
      requestParams: meta.requestParams || null,
      providerRetries: partial.providerRetries ?? meta.providerRetries ?? 0,
      respondedEngines: partial.respondedEngines || meta.respondedEngines || [],
      unresponsiveEngines: partial.unresponsiveEngines || meta.unresponsiveEngines || [],
      numberOfResults: meta.numberOfResults ?? null,
      suggestions: meta.suggestions || [],
      corrections: meta.corrections || [],
      resultCount: accepted,
      returnedResultCount: returned,
      siteRejectedCount: partial.siteRejectedCount ?? 0,
      newUrlCount: partial.newUrlCount ?? 0,
      memoryStatus: partial.memoryStatus || null,
      snippets: Array.isArray(partial.snippets)
        ? partial.snippets.slice(0, 3)
        : compactSearchSnippets(partial.sources),
      outcome: inferSearchOutcome({
        error: partial.error,
        skipped: partial.skipped,
        memoryStatus: partial.memoryStatus,
        resultCount: accepted,
        siteRejectedCount: partial.siteRejectedCount ?? 0,
      }),
      error: serializeSearchError(partial.error),
      skipped: partial.skipped || null,
      step: this.step,
    };
    this.searchOutcomes.push(record);
    return record;
  }

  recentSearchOutcomes(limit = 12) {
    return this.searchOutcomes.slice(-Math.max(1, Number(limit) || 12));
  }

  recordFilteredQuery(gapId, query, reason = 'filtered') {
    const gap = this.getGap(gapId);
    if (!gap || !query) return;
    gap.exhaustedAngles = [...new Set([...(gap.exhaustedAngles || []), query])];
    gap.filteredQueries = [
      ...(gap.filteredQueries || []),
      { query, reason, step: this.step },
    ];
    if (reason === 'site_filtered_all') this.recovery.siteFilteredAllQueries += 1;
  }

  recordTransientSearch(error = null) {
    this.recovery.transientFailures += 1;
    this.recovery.providerRetries += Number(error?.retries || error?.providerRetries || 0);
  }

  noteProgressKind(kind) {
    if (kind === 'progress') {
      this.recovery.transientStreak = 0;
      this.recovery.duplicateStreak = 0;
      this.recovery.semanticNoYieldStreak = 0;
      this.recovery.relevanceRejectedStreak = 0;
      return;
    }
    if (kind === 'transient') {
      this.recovery.transientStreak += 1;
      return;
    }
    if (kind === 'duplicate') {
      this.recovery.duplicateStreak += 1;
      return;
    }
    if (kind === 'relevance_rejected') {
      this.recovery.relevanceRejectedStreak = (this.recovery.relevanceRejectedStreak || 0) + 1;
      return;
    }
    this.recovery.semanticNoYieldStreak += 1;
  }

  setPlannerFailure(failure, extra = {}) {
    if (!failure) return;
    this.recovery.plannerFailures += 1;
    this.recovery.lastPlannerFailure = {
      reason: typeof failure === 'object' ? (failure.reason || failure.code || failure) : failure,
      gapId: extra.gapId || null,
      step: this.step,
      stage: extra.stage || extra.plannerMode || 'planner',
    };
  }

  clearPlannerFailure({ gapId } = {}) {
    const last = this.recovery.lastPlannerFailure;
    if (!last) return;
    if (typeof last === 'object' && last.gapId && gapId && last.gapId !== gapId) return;
    this.recovery.lastPlannerFailure = null;
  }

  candidateDecisionForGap(candidate, gapId) {
    return candidate?.gapMatches?.[gapId]?.relevanceDecision
      || candidate?.relevanceDecisionByGap?.[gapId]
      || (candidate?.gapId === gapId ? candidate.relevanceDecision : null)
      || null;
  }

  isEligibleUnreadCandidate(candidate, gapId) {
    if (!candidate) return false;
    if (this.readSourceIds.has(candidate.id) || candidate.status !== 'unread') return false;
    const decision = this.candidateDecisionForGap(candidate, gapId);
    if (!decision || decision.reasonCode === 'rerank_pending') return false;
    return decision.accepted === true;
  }

  rejectionFeedback(gapId) {
    const counts = {};
    for (const candidate of this.candidates.values()) {
      if (this.readSourceIds.has(candidate.id)) continue;
      const decision = this.candidateDecisionForGap(candidate, gapId);
      if (!decision) continue;
      if (decision.accepted === false || decision.reasonCode === 'rerank_pending') {
        const reason = decision.reasonCode || 'rejected';
        counts[reason] = (counts[reason] || 0) + 1;
      }
    }
    return counts;
  }

  observeHosts(sources = []) {
    for (const source of sources) {
      const hostname = policyHostnameOf(source?.url || source?.id);
      if (hostname) this.observedHosts.add(hostname);
    }
  }

  refreshBudgetView({ budget, minLlmTokens, targetLlmTokens, actionCosts } = {}) {
    const manager = budget || this.budgetManager;
    if (manager) {
      const nextMin = minLlmTokens !== undefined ? minLlmTokens : targetLlmTokens;
      if (nextMin !== undefined) {
        manager.minLlmTokens = Number(nextMin) || 0;
        manager.targetLlmTokens = manager.minLlmTokens;
        this.minLlmTokens = manager.minLlmTokens;
        this.targetLlmTokens = manager.minLlmTokens;
      } else if (this.minLlmTokens && !manager.minLlmTokens) {
        manager.minLlmTokens = this.minLlmTokens;
        manager.targetLlmTokens = this.minLlmTokens;
      }
      manager.updateReportReserve(estimateReportPromptTokens({ query: this.query, findings: this.findings }));
      this.budgetView = buildBudgetView({
        budget: manager,
        actionCosts: actionCosts || this.actionCosts,
        minLlmTokens: manager.minLlmTokens,
      });
    }
    this.syncGapCoverage();
    this.readiness = evaluateReadinessGate({
      query: this.query,
      findings: this.findings,
      gaps: this.gaps,
      profile: this.profile,
      state: this,
    });
    this.sufficiency = evaluateExploratorySufficiency({
      query: this.query,
      findings: this.findings,
      gaps: this.gaps,
      state: this,
    });
    this.sufficiency = {
      ...this.sufficiency,
      sufficient: Boolean(this.readiness?.pass),
      readiness: this.readiness,
      method: 'readiness_gate',
    };
    return this.budgetView;
  }

  focusGap() {
    const actionable = this.gaps.filter((gap) => (
      ['open', 'searched', 'missing'].includes(gap.status)
      || (gap.status === 'body_read' && this.gapNeedsPrimaryEvidence(gap))
    ) && gap.status !== 'blocked');
    const pool = actionable.length ? actionable : this.gaps;
    if (!pool.length) return this.gaps[0];
    return pool[this.step % pool.length];
  }

  searchedQueries() {
    return [...new Set([
      ...this.gaps.flatMap((gap) => gap.searchedQueries || []),
      ...this.observations
        .filter((observation) => observation.type === 'search_result')
        .filter((observation) => !['rate_limited', 'provider_error'].includes(observation.outcome))
        .map((observation) => observation.query)
        .filter(Boolean),
    ])];
  }

  addKnowledge({ gapId, sourceId, learned }) {
    const text = String(learned || '').trim();
    if (!text) return;
    this.knowledge.push({ gapId: gapId || 'gap-1', sourceId: sourceId || null, learned: text.slice(0, KNOWLEDGE_SNIPPET_CHARS) });
  }

  candidateScore(candidate) {
    const tierBoost = candidate.tier === 'required_primary' ? 1 : 0;
    const host = policyHostnameOf(candidate.url || candidate.id);
    const preferredBoost = this.gaps.some((gap) => (
      (gap.preferredHosts || []).some((preferred) => hostnamesMatch(host, preferred))
    )) ? 0.15 : 0;
    return (candidate.rerank?.score ?? candidate.rerankScore ?? 0) + (candidate.freq || 0) * 0.1
      + hostnameWeight(candidate.url) + tierBoost + preferredBoost;
  }

  rankedCandidates() {
    const ranked = [...this.candidates.values()].sort((a, b) => this.candidateScore(b) - this.candidateScore(a));
    const perHostname = new Map();
    const selected = [];
    for (const candidate of ranked) {
      const hostname = sourceDiversityKey(candidate) || policyHostnameOf(candidate.url);
      const count = perHostname.get(hostname) || 0;
      if (hostname && count >= MAX_CANDIDATES_PER_HOSTNAME && !this.readSourceIds.has(candidate.id) && candidate.status === 'unread') continue;
      if (hostname) perHostname.set(hostname, count + 1);
      selected.push(candidate);
      if (selected.length >= RANKED_CANDIDATE_LIMIT) break;
    }
    return selected;
  }

  snapshot() {
    const gaps = this.gaps.map((gap) => ({
      ...gap,
      covered: this.gapCovered(gap.id),
    }));
    return {
      query: this.query,
      step: this.step,
      maxSteps: this.maxSteps,
      stepsRemaining: this.maxSteps > 0 ? Math.max(0, this.maxSteps - this.step) : null,
      lastAction: this.lastAction,
      profile: {
        flags: this.profile?.flags || {},
        requiredHosts: this.profile?.requiredHosts || [],
        preferredHosts: this.profile?.preferredHosts || [],
        requiredSourceTypes: this.profile?.requiredSourceTypes || [],
        minIndependentSources: this.profile?.minIndependentSources || 1,
        evidenceScope: this.evidenceScope || this.profile?.evidenceScope || 'web',
      },
      brief: this.brief,
      gaps,
      focusGapId: this.focusGap()?.id || 'gap-1',
      findingsCount: this.findings.length,
      bodyEvidenceCoverage: {
        hasBodyEvidence: this.hasBodyEvidence(),
        resolvedGaps: gaps.filter((gap) => gap.covered || ['verified', 'resolved', 'body_read'].includes(gap.status)).map((gap) => gap.id),
        openGaps: gaps.filter((gap) => ['open', 'searched', 'missing'].includes(gap.status) && !gap.covered).map((gap) => gap.id),
      },
      cycle: { ...this.cycle },
      readiness: this.readiness,
      candidates: this.rankedCandidates().slice(0, SNAPSHOT_CANDIDATE_LIMIT).map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        score: Math.round(this.candidateScore(candidate) * 1000) / 1000,
        gapId: candidate.gapId,
        read: this.readSourceIds.has(candidate.id),
      })),
      searchedQueries: this.searchedQueries(),
      knowledge: this.knowledge,
      diary: this.diary.slice(-DIARY_SNAPSHOT_LINES),
      evaluationRetries: this.evaluationRetries,
      budget: this.budgetView,
      sufficiency: this.sufficiency,
      qualityGate: this.readiness ? {
        sufficient: this.readiness.pass,
        inconclusive: !this.readiness.pass,
        flags: this.readiness.flags,
        decision: this.readiness.decision,
        method: this.readiness.method,
      } : (this.sufficiency ? {
        sufficient: this.sufficiency.sufficient,
        inconclusive: this.sufficiency.inconclusive,
        flags: this.sufficiency.flags,
        decision: this.sufficiency.decision,
        method: this.sufficiency.method,
      } : null),
      marginal: {
        ...this.marginal,
        duplicateResultRatio: this.marginal.searchCount
          ? this.marginal.duplicateResultCount / this.marginal.searchCount
          : 0,
      },
      relevance: { ...this.relevance },
      recovery: {
        ...this.recovery,
        blockedGaps: gaps.filter((gap) => gap.status === 'blocked').map((gap) => ({
          gapId: gap.id,
          answerSlot: gap.answerSlot || null,
          blockedReason: gap.blockedReason || 'repair_exhausted',
          failures: Number(gap.repairFailures) || 0,
        })),
      },
    };
  }

  snapshotForAgent() {
    const gaps = this.gaps.filter((gap) => !gap.rollup).map((gap) => ({
      id: gap.id,
      question: gap.question,
      status: gap.status,
      priority: gap.priority || null,
      requiredHosts: gap.requiredHosts || [],
      preferredHosts: gap.preferredHosts || [],
      requiredSlot: Boolean(gap.requiredSlot),
      slotSupport: gap.slotSupport?.verdict || null,
      blockedReason: gap.blockedReason || null,
    }));
    const focusGapId = this.focusGap()?.id || 'gap-1';
    const unread = this.rankedCandidates()
      .filter((candidate) => this.isEligibleUnreadCandidate(candidate, focusGapId))
      .slice(0, SNAPSHOT_CANDIDATE_LIMIT)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        score: Math.round(this.candidateScore(candidate) * 1000) / 1000,
        gapId: focusGapId,
      }));
    const readiness = this.readiness;
    return {
      query: this.query,
      step: this.step,
      maxSteps: this.maxSteps,
      lastAction: this.lastAction,
      focusGapId,
      candidateRejections: this.rejectionFeedback(focusGapId),
      budget: this.budgetView,
      readiness: readiness ? {
        pass: readiness.pass,
        failures: (readiness.failures || []).slice(0, 8).map((failure) => ({
          code: failure.code || failure.reason || null,
          message: failure.message || null,
          gapId: failure.gapId || null,
        })),
      } : null,
      gaps,
      unreadCandidates: unread,
      recentSearchOutcomes: this.recentSearchOutcomes(8).map((item) => ({
        query: item.query,
        outcome: item.outcome,
        gapId: item.gapId,
        resultCount: item.resultCount,
        siteRejectedCount: item.siteRejectedCount,
        respondedEngines: item.respondedEngines,
        unresponsiveEngines: item.unresponsiveEngines,
        snippets: item.snippets,
      })),
      knowledge: this.knowledge.slice(-6),
      diary: this.diary.slice(-8),
      cycle: { ...this.cycle },
      marginal: { ...this.marginal },
      recovery: {
        invalidSteps: this.recovery.invalidSteps,
        recoveryRounds: this.recovery.recoveryRounds,
        duplicateQueryRejections: this.recovery.duplicateQueryRejections,
        siteFilteredAllQueries: this.recovery.siteFilteredAllQueries,
        plannerRejectedQueries: this.recovery.plannerRejectedQueries,
        plannerRetryCount: this.recovery.plannerRetryCount,
        lastPlannerFailure: this.recovery.lastPlannerFailure,
      },
    };
  }

  addCandidates(sources, gapId, { query = '', clusterById = {} } = {}) {
    const gap = this.getGap(gapId);
    let added = 0;
    for (const source of sources || []) {
      const id = source.id || source.url;
      if (!id) continue;
      const existing = this.candidates.get(id) || {};
      const priorMatch = existing.gapMatches?.[gapId] || {};
      const nextTier = classifySourceTier(source, gap);
      const gapMatch = {
        ...priorMatch,
        queries: [...new Set([...(priorMatch.queries || []), query].filter(Boolean))],
        tier: nextTier,
        rerank: source.rerank || priorMatch.rerank || null,
        rerankScore: source.rerank?.score ?? source.rerankScore ?? priorMatch.rerankScore ?? null,
      };
      const record = {
        ...existing,
        ...source,
        id,
        gapId: existing.gapId || gapId || 'gap-1',
        gapIds: [...new Set([...(existing.gapIds || [existing.gapId]), gapId].filter(Boolean))],
        gapMatches: {
          ...(existing.gapMatches || {}),
          [gapId]: gapMatch,
        },
        relevanceDecisionByGap: {
          ...(existing.relevanceDecisionByGap || {}),
          [gapId]: gapMatch.relevanceDecision || null,
        },
        hostname: existing.hostname || policyHostnameOf(source.url || id),
        diversityKey: existing.diversityKey || sourceDiversityKey({ ...existing, ...source }, source.url || id),
        registrableDomain: existing.registrableDomain || registrableDomainFromUrl(source.url || id),
        tier: existing.tier || nextTier,
        clusterId: clusterById[id] || existing.clusterId || source.clusterId || null,
        status: existing.status || 'unread',
        freq: (existing.freq || 0) + 1,
      };
      const pooled = this.urlPool.add({
        ...record,
        rerank: source.rerank ?? null,
        rerankScore: source.rerank?.score ?? source.rerankScore ?? null,
      }, { gapId, query, gap, clusterId: record.clusterId });
      if (pooled?.record?.status === 'duplicate') record.status = 'duplicate';
      if (pooled?.added) added += 1;
      this.candidates.set(id, { ...record, ...(pooled?.record || {}) });
      if (gap && !gap.candidateUrls.includes(id)) gap.candidateUrls.push(id);
    }
    this.cycle.newUrlCount += added;
    return added;
  }

  markCandidateStatus(id, status, reason = null) {
    const candidate = this.candidates.get(id);
    if (candidate) {
      candidate.status = status;
      if (reason) candidate.skipReason = reason;
    }
    this.urlPool.mark(id, status, reason);
  }

  pickPolicyReads(count = 2, gapId = null) {
    const gap = this.getGap(gapId || this.focusGap()?.id);
    const unread = [...this.candidates.values()].filter((candidate) => (
      !this.readSourceIds.has(candidate.id)
      && candidate.status !== 'read'
      && candidate.status !== 'failed'
      && candidate.status !== 'waf'
      && candidate.status !== 'irrelevant'
      && candidate.status !== 'duplicate'
      && (!gapId || candidate.gapId === gap.id || candidate.gapIds?.includes(gap.id))
    )).map((candidate) => {
      const match = candidate.gapMatches?.[gap.id];
      const primaryGapCandidate = candidate.gapId === gap.id;
      const scopedRerank = match?.rerank ?? (primaryGapCandidate ? candidate.rerank : null);
      const scopedRerankScore = match?.rerank?.score
        ?? match?.rerankScore
        ?? (primaryGapCandidate ? (candidate.rerank?.score ?? candidate.rerankScore) : null);
      return {
        ...candidate,
        gapId: gap.id,
        tier: match?.tier || candidate.tier,
        rerank: scopedRerank,
        rerankScore: scopedRerankScore,
        relevanceDecision: match?.relevanceDecision || (primaryGapCandidate ? candidate.relevanceDecision : null),
      };
    });
    const alreadyRead = new Set(
      [...this.readSourceIds].map((id) => {
        const candidate = this.candidates.get(id);
        return sourceDiversityKey(candidate || { url: id }, candidate?.url || id);
      }).filter(Boolean),
    );
    const selected = selectReadsByPolicy({
      candidates: unread,
      gap,
      alreadyReadHostnames: alreadyRead,
      maxPerHostname: MAX_CANDIDATES_PER_HOSTNAME,
      minCount: Math.min(2, count),
      maxCount: count,
      relevance: this.settings?.research?.read?.relevance ? {
        ...this.settings.research.read.relevance,
        enforceEntity: this.settings.research.read.relevance.entityGuard !== false,
        query: gap.question || this.query,
        entities: this.brief?.entities || this.profile?.brief?.entities || [],
        entityAliases: this.brief?.entityAliases || this.profile?.brief?.entityAliases || [],
        rerankProvider: this.settings?.research?.providers?.rerank?.provider || null,
        externalRerankEnabled: isExternalRerankProvider(this.settings?.research?.providers?.rerank?.provider),
      } : null,
    });
    for (const picked of selected) {
      const candidate = this.candidates.get(picked.id);
      if (!candidate || !picked.relevanceDecision) continue;
      const match = candidate.gapMatches?.[gap.id] || {};
      candidate.gapMatches = {
        ...(candidate.gapMatches || {}),
        [gap.id]: { ...match, relevanceDecision: picked.relevanceDecision },
      };
      candidate.relevanceDecisionByGap = {
        ...(candidate.relevanceDecisionByGap || {}),
        [gap.id]: picked.relevanceDecision,
      };
      if (candidate.gapId === gap.id) candidate.relevanceDecision = picked.relevanceDecision;
    }
    return selected;
  }

  validate(action) {
    if (!ACTIONS.has(action?.action)) return 'unknown_action';
    const normalized = normalizeAction(action.action);
    if (this.maxSteps > 0 && this.step >= this.maxSteps && !FINALIZE_ACTIONS.has(action.action)) return 'max_steps';
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
      const targetGapId = action.gapId || this.focusGap()?.id;
      const rejected = action.sourceIds
        .map((id) => this.candidates.get(id)?.gapMatches?.[targetGapId]?.relevanceDecision)
        .find((decision) => decision?.accepted === false);
      if (rejected) return rejected.reasonCode || 'relevance_rejected';
      if (this.lastAction === 'read') {
        const unread = action.sourceIds.filter((id) => !this.readSourceIds.has(id));
        if (!unread.length) return 'repeat_action';
      }
    }
    if (action.action === this.lastAction && !['answer', 'stop', 'read', 'search', 'draft', 'finalize'].includes(action.action)) {
      return 'repeat_action';
    }
    if (FINALIZE_ACTIONS.has(action.action) && (this.cycle.afterSearch || this.lastAction === 'search') && !this.cycleHasSuccessfulBody()) {
      return 'answer_after_search';
    }
    if (action.action === 'search') {
      const queries = Array.isArray(action.queries) ? action.queries : [];
      const merged = [String(action.query || '').trim(), ...queries.map((query) => String(query || '').trim())].filter(Boolean);
      const primary = merged[0];
      if (!primary) return 'missing_query';
      if (this.lastAction === 'search') {
        const lastSearch = [...this.observations].reverse().find((observation) => observation.type === 'search_result');
        const emptySearchRetry = lastSearch?.resultCount === 0;
        const sameQuery = lastSearch && merged.includes(lastSearch.query);
        if (!emptySearchRetry && sameQuery) return 'repeat_action';
      }
      const searched = this.searchedQueries();
      if (merged.every((query) => searched.some((seen) => similarQuestions(seen, query, 0.86)))) {
        return 'duplicate_query';
      }
    }
    if (action.action === 'reflect') {
      const question = String(action.gapQuestion || '').trim();
      if (question && this.gaps.some((gap) => similarQuestions(gap.question, question))) return 'repeat_gap';
    }
    if (FINALIZE_ACTIONS.has(action.action) && this.forbidFinalizeUntilExplore) return 'finalize_not_allowed';
    if (normalized === 'finalize' && this.findings.length === 0 && this.candidates.size === 0) return 'no_evidence';
    return null;
  }

  unresolvedReportNotes() {
    const unresolved = this.gaps.filter((gap) => ['open', 'searched', 'missing', 'blocked'].includes(gap.status)
      || (gap.status === 'body_read' && this.gapNeedsPrimaryEvidence(gap) && !this.gapHasRequiredHostBody(gap.id)));
    const blockedHosts = [...new Set(unresolved.flatMap((gap) => gap.requiredHosts || []))];
    const secondaryOnly = this.findings.flatMap((finding) => (finding.sources || [])
      .filter(sourceHasBody)
      .filter((source) => ['mainstream', 'reprint', 'ugc', 'unknown'].includes(source.tier || classifySourceTier(source, this.getGap(finding.gapId))))
      .map((source) => source.url || source.id));
    return {
      unresolvedGaps: unresolved.map((gap) => ({
        id: gap.id,
        question: gap.question,
        status: gap.status,
        requiredHosts: gap.requiredHosts,
        reason: gap.blockedReason,
      })),
      blockedHosts,
      secondaryOnlyClaims: secondaryOnly.slice(0, 12),
      unsupportedDecisions: this.readiness?.pass
        ? []
        : (this.readiness?.failures || []).map((failure) => failure.message),
    };
  }
}
