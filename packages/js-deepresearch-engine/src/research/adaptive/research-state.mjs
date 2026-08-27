import { ActionCostTracker, buildBudgetView, estimateReportPromptTokens } from './budget-view.mjs';
import {
  evaluateExploratorySufficiency,
  similarQuestions,
  sourceHasBody,
} from './exploratory-sufficiency.mjs';
import { hostnameOf } from './hostname-policy.mjs';
import { gapEvidenceMeetsContract } from './readiness-gate.mjs';
import { profileGapDefaults } from './research-profile.mjs';
import { upsertUrlPool } from './url-pool.mjs';

export { hostnameOf };

const ACTIONS = new Set(['search', 'read', 'reflect', 'draft', 'finalize', 'answer', 'stop']);
const FINALIZE_ACTIONS = new Set(['answer', 'draft', 'finalize']);
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
  const hostname = hostnameOf(url);
  if (!hostname) return 0;
  if (PENALIZE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_PENALTY;
  if (BOOST_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_BOOST;
  return 0;
}

function createGap({
  id,
  question,
  status = 'open',
  priority = 'normal',
  depth = 0,
  requiredSourceTypes = [],
  requiredHosts = [],
  preferredHosts = [],
  blockedHosts = [],
  maxAgeDays = null,
  minIndependentSources = 1,
} = {}) {
  return {
    id,
    question,
    status,
    priority,
    depth,
    requiredSourceTypes: [...requiredSourceTypes],
    requiredHosts: [...requiredHosts],
    preferredHosts: [...preferredHosts],
    blockedHosts: [...blockedHosts],
    maxAgeDays,
    minIndependentSources: Math.max(1, Number(minIndependentSources) || 1),
    searchedQueries: [],
    candidateUrls: [],
    readSourceIds: [],
    evidencePassageIds: [],
  };
}

export class ResearchState {
  constructor({ query, maxSteps = 0, maxGapDepth = 2, minLlmTokens = 0, targetLlmTokens = 0, budget = null, profile = null } = {}) {
    this.query = query;
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
    this.profile = profile;
    this.step = 0;
    this.lastAction = null;
    this.gaps = [createGap({
      id: 'gap-1',
      question: query,
      priority: 'critical',
      depth: 0,
      ...(profile ? profileGapDefaults(profile) : {}),
    })];
    this.findings = [];
    this.candidates = new Map();
    this.readSourceIds = new Set();
    this.failedSourceIds = new Set();
    this.knowledge = [];
    this.observations = [];
    this.diary = [];
    this.evaluationRetries = 0;
    this.candidateEvaluationTokens = 0;
    this.searchCycle = { pending: false, successfulBodyReads: 0, newUrls: 0, gapId: null };
    this.lastDraftKey = null;
    this.embeddingTraces = [];
  }

  applyProfile(profile) {
    this.profile = profile;
    if (!profile) return;
    const defaults = profileGapDefaults(profile);
    const root = this.gaps[0];
    if (!root) return;
    root.requiredSourceTypes = [...new Set([...(root.requiredSourceTypes || []), ...defaults.requiredSourceTypes])];
    root.requiredHosts = [...new Set([...(root.requiredHosts || []), ...defaults.requiredHosts])];
    root.preferredHosts = [...new Set([...(root.preferredHosts || []), ...defaults.preferredHosts])];
    root.maxAgeDays = root.maxAgeDays || defaults.maxAgeDays;
    root.minIndependentSources = Math.max(root.minIndependentSources || 1, defaults.minIndependentSources || 1);
  }

  addDiary(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.diary.push(`step ${this.step}: ${text}`);
  }

  addGap(question, priority = 'normal', options = {}) {
    const text = String(question || '').trim();
    if (!text) return null;
    if (this.gaps.some((gap) => similarQuestions(gap.question, text))) return null;
    const nextDepth = options.depth ?? 1;
    if (this.maxGapDepth > 0 && nextDepth > this.maxGapDepth) return null;
    const inherited = options.inheritProfile !== false && this.profile ? profileGapDefaults(this.profile) : {};
    const gap = createGap({
      id: `gap-${this.gaps.length + 1}`,
      question: text,
      priority,
      depth: nextDepth,
      requiredSourceTypes: options.requiredSourceTypes || inherited.requiredSourceTypes || [],
      requiredHosts: options.requiredHosts || inherited.requiredHosts || [],
      preferredHosts: options.preferredHosts || inherited.preferredHosts || [],
      blockedHosts: options.blockedHosts || [],
      maxAgeDays: options.maxAgeDays ?? inherited.maxAgeDays,
      minIndependentSources: options.minIndependentSources || inherited.minIndependentSources || 1,
    });
    if (options.repairOf) gap.repairOf = options.repairOf;
    this.gaps.push(gap);
    return gap;
  }

  gapById(gapId) {
    return this.gaps.find((gap) => gap.id === gapId) || this.gaps[0];
  }

  gapCovered(gapId) {
    const gap = this.gapById(gapId);
    if (!gap) return false;
    if (gap.status === 'verified') return true;
    return gapEvidenceMeetsContract(gap, this.findings);
  }

  hasBodyEvidence() {
    return this.findings.some((finding) => (finding.sources || []).some(sourceHasBody));
  }

  cycleHadSuccessfulBody() {
    return Number(this.searchCycle?.successfulBodyReads) > 0;
  }

  recordSearchCycle({ gapId, newUrls = 0 } = {}) {
    this.searchCycle = {
      pending: true,
      successfulBodyReads: 0,
      newUrls,
      gapId: gapId || 'gap-1',
    };
  }

  recordSuccessfulBodies(count = 0) {
    this.searchCycle.successfulBodyReads = (this.searchCycle.successfulBodyReads || 0) + Number(count || 0);
  }

  markGapSearched(gapId, query) {
    const gap = this.gapById(gapId);
    if (!gap) return;
    if (query && !gap.searchedQueries.includes(query)) gap.searchedQueries.push(query);
    if (gap.status === 'open') gap.status = 'searched';
  }

  markGapBlocked(gapId, host = null) {
    const gap = this.gapById(gapId);
    if (!gap) return;
    gap.status = 'blocked';
    if (host && !gap.blockedHosts.includes(host)) gap.blockedHosts.push(host);
  }

  markRemainingGapsMissing() {
    for (const gap of this.gaps) {
      if (['verified', 'blocked'].includes(gap.status)) continue;
      if (!this.gapCovered(gap.id)) gap.status = 'missing';
    }
  }

  syncGapCoverage() {
    for (const gap of this.gaps) {
      const closed = gapEvidenceMeetsContract(gap, this.findings);
      if (closed) {
        gap.status = 'verified';
        gap.resolvedAtStep = this.step;
        continue;
      }
      const bodies = this.findings
        .filter((finding) => finding.gapId === gap.id)
        .flatMap((finding) => finding.sources || [])
        .filter(sourceHasBody);
      if (bodies.length && gap.status !== 'blocked' && gap.status !== 'missing') {
        gap.status = 'body_read';
      } else if ((gap.searchedQueries || []).length && ['open'].includes(gap.status)) {
        gap.status = 'searched';
      }
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
    this.sufficiency = evaluateExploratorySufficiency({
      query: this.query,
      findings: this.findings,
      gaps: this.gaps,
      state: this,
    });
    this.readiness = this.sufficiency?.readiness || null;
    return this.budgetView;
  }

  focusGap() {
    const requiredOpen = this.gaps.filter((gap) => (
      (gap.priority === 'critical' || gap.requiredHosts?.length || (gap.requiredSourceTypes || []).includes('primary'))
      && !this.gapCovered(gap.id)
      && gap.status !== 'blocked'
    ));
    const open = this.gaps.filter((gap) => !this.gapCovered(gap.id) && gap.status !== 'blocked' && gap.status !== 'verified');
    const pool = requiredOpen.length ? requiredOpen : (open.length ? open : this.gaps.filter((gap) => gap.status === 'open'));
    if (!pool.length) return this.gaps[0];
    return pool[this.step % pool.length];
  }

  searchedQueries() {
    return [...new Set([
      ...this.observations
        .filter((observation) => observation.type === 'search_result')
        .map((observation) => observation.query)
        .filter(Boolean),
      ...this.gaps.flatMap((gap) => gap.searchedQueries || []),
    ])];
  }

  addKnowledge({ gapId, sourceId, learned }) {
    const text = String(learned || '').trim();
    if (!text) return;
    this.knowledge.push({ gapId: gapId || 'gap-1', sourceId: sourceId || null, learned: text.slice(0, KNOWLEDGE_SNIPPET_CHARS) });
  }

  candidateScore(candidate) {
    const tierBoost = candidate.tier === 'required_primary' ? 1.5 : (candidate.tier === 'other_primary' ? 0.6 : 0);
    return (candidate.rerank?.score || candidate.rerankScore || 0) + (candidate.freq || 0) * 0.1 + hostnameWeight(candidate.url) + tierBoost;
  }

  rankedCandidates() {
    const ranked = [...this.candidates.values()].sort((a, b) => this.candidateScore(b) - this.candidateScore(a));
    const perHostname = new Map();
    const selected = [];
    for (const candidate of ranked) {
      const hostname = hostnameOf(candidate.url);
      const count = perHostname.get(hostname) || 0;
      if (hostname && count >= MAX_CANDIDATES_PER_HOSTNAME && !this.readSourceIds.has(candidate.id) && candidate.status !== 'read') continue;
      perHostname.set(hostname, count + 1);
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
      profile: this.profile ? {
        requirements: this.profile.requirements,
        requiredHosts: this.profile.requiredHosts,
        requiredSourceTypes: this.profile.requiredSourceTypes,
      } : null,
      gaps,
      focusGapId: this.focusGap()?.id || 'gap-1',
      findingsCount: this.findings.length,
      bodyEvidenceCoverage: {
        hasBodyEvidence: this.hasBodyEvidence(),
        cycleSuccessfulBodyReads: this.searchCycle.successfulBodyReads,
        resolvedGaps: gaps.filter((gap) => gap.covered || gap.status === 'verified').map((gap) => gap.id),
        openGaps: gaps.filter((gap) => !gap.covered && gap.status !== 'verified').map((gap) => gap.id),
      },
      candidates: this.rankedCandidates().slice(0, SNAPSHOT_CANDIDATE_LIMIT).map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        score: Math.round(this.candidateScore(candidate) * 1000) / 1000,
        gapId: candidate.gapId,
        read: this.readSourceIds.has(candidate.id) || candidate.status === 'read',
      })),
      searchedQueries: this.searchedQueries(),
      knowledge: this.knowledge,
      diary: this.diary.slice(-DIARY_SNAPSHOT_LINES),
      evaluationRetries: this.evaluationRetries,
      budget: this.budgetView,
      sufficiency: this.sufficiency,
      readiness: this.readiness,
      qualityGate: this.sufficiency ? {
        sufficient: this.sufficiency.sufficient,
        inconclusive: this.sufficiency.inconclusive,
        flags: this.sufficiency.flags,
        decision: this.sufficiency.decision,
        method: this.sufficiency.method,
      } : null,
    };
  }

  addCandidates(sources, gapId, query = '') {
    const gap = this.gapById(gapId);
    const before = this.candidates.size;
    const result = upsertUrlPool(this.candidates, sources, { gapId: gapId || 'gap-1', query, gap });
    for (const source of sources || []) {
      const id = source.id || source.url;
      if (id && gap && !gap.candidateUrls.includes(id)) gap.candidateUrls.push(id);
    }
    return { ...result, added: this.candidates.size - before };
  }

  validate(action) {
    if (!ACTIONS.has(action?.action)) return 'unknown_action';
    if (this.maxSteps > 0 && this.step >= this.maxSteps && !['answer', 'stop', 'finalize', 'draft'].includes(action.action)) {
      return 'max_steps';
    }
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
      if (this.lastAction === 'read') {
        const unread = action.sourceIds.filter((id) => !this.readSourceIds.has(id));
        if (!unread.length) return 'repeat_action';
      }
    }
    if (action.action === this.lastAction && !['answer', 'stop', 'read', 'search', 'finalize'].includes(action.action)) {
      return 'repeat_action';
    }
    if (FINALIZE_ACTIONS.has(action.action) && this.lastAction === 'search' && !this.cycleHadSuccessfulBody() && !this.hasBodyEvidence()) {
      return 'answer_after_search';
    }
    if (FINALIZE_ACTIONS.has(action.action) && this.lastAction === 'search' && !this.cycleHadSuccessfulBody()) {
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
      const lastSearch = [...this.observations].reverse().find((observation) => observation.type === 'search_result');
      const emptySearchRetry = lastSearch?.resultCount === 0;
      if (!emptySearchRetry && merged.some((query) => searched.some((previous) => similarQuestions(previous, query, 0.86)))) {
        return 'duplicate_query';
      }
    }
    if (action.action === 'reflect') {
      const question = String(action.gapQuestion || '').trim();
      if (question && this.gaps.some((gap) => similarQuestions(gap.question, question))) return 'repeat_gap';
    }
    if (FINALIZE_ACTIONS.has(action.action) && this.findings.length === 0 && this.candidates.size === 0) return 'no_evidence';
    return null;
  }
}
