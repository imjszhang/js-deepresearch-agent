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
  registrableDomainFromUrl,
  selectReadsByPolicy,
} from './source-policy.mjs';
import { sourceDiversityKey } from '../source-candidates.mjs';
import { UrlPool } from './url-pool.mjs';

export { hostnameOf } from './source-policy.mjs';

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
  } = {}) {
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
    this.profile = profile || inferResearchProfile(query);
    this.step = 0;
    this.lastAction = null;
    this.gaps = [createRootGap(query, this.profile)];
    this.findings = [];
    this.candidates = new Map();
    this.urlPool = new UrlPool({ maxPerHostname: MAX_CANDIDATES_PER_HOSTNAME });
    this.readSourceIds = new Set();
    this.knowledge = [];
    this.observations = [];
    this.diary = [];
    this.evaluationRetries = 0;
    this.forbidFinalizeUntilExplore = false;
    this.embeddingTraces = [];
    this.cycle = {
      afterSearch: false,
      successfulBodyReads: 0,
      newUrlCount: 0,
      lastSearchQuery: null,
    };
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
    const gap = createGapRecord({
      id: `gap-${this.gaps.length + 1}`,
      question: text,
      priority,
      depth: nextDepth,
      profile: this.profile,
      requiredHosts: options.requiredHosts,
      preferredHosts: options.preferredHosts,
      requiredSourceTypes: options.requiredSourceTypes,
      minIndependentSources: options.minIndependentSources,
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
    if (needsFiling && !documentMatchesQuerySubject(source, this.query)) return false;
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
    return this.findings.some((finding) => (
      finding.gapId === gapId
      && (finding.sources || []).some((source) => this.sourceSatisfiesPrimary(source, gap))
    ));
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
  }

  syncGapCoverage() {
    for (const gap of this.gaps) {
      const sources = this.findings
        .filter((finding) => finding.gapId === gap.id)
        .flatMap((finding) => (finding.sources || []).filter(sourceHasBody));
      gap.readSourceIds = [...new Set([
        ...(gap.readSourceIds || []),
        ...sources.map((source) => source.id || source.url).filter(Boolean),
      ])];
      const hasBody = sources.length > 0;
      const requiredOk = this.gapHasRequiredHostBody(gap.id);
      const domains = new Set(sources.map((source) => registrableDomainFromUrl(source.url || source.id)).filter(Boolean));
      const independentOk = domains.size >= (Number(gap.minIndependentSources) || 1);
      if (gap.status === 'blocked' || gap.status === 'missing') continue;
      if (hasBody && requiredOk && independentOk) {
        gap.status = 'verified';
        gap.resolvedAtStep = this.step;
      } else if (hasBody) {
        gap.status = 'body_read';
        gap.resolvedAtStep = this.step;
      }
    }
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
    ));
    const pool = actionable.length ? actionable : this.gaps;
    if (!pool.length) return this.gaps[0];
    return pool[this.step % pool.length];
  }

  searchedQueries() {
    return [...new Set([
      ...this.gaps.flatMap((gap) => gap.searchedQueries || []),
      ...this.observations
        .filter((observation) => observation.type === 'search_result')
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
    return (candidate.rerank?.score || candidate.rerankScore || 0) + (candidate.freq || 0) * 0.1 + hostnameWeight(candidate.url) + tierBoost;
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
        evidenceScope: this.profile?.evidenceScope || 'web',
      },
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
    };
  }

  addCandidates(sources, gapId, { query = '', clusterById = {} } = {}) {
    const gap = this.getGap(gapId);
    let added = 0;
    for (const source of sources || []) {
      const id = source.id || source.url;
      if (!id) continue;
      const existing = this.candidates.get(id) || {};
      const record = {
        ...existing,
        ...source,
        id,
        gapId: gapId || existing.gapId || 'gap-1',
        hostname: existing.hostname || policyHostnameOf(source.url || id),
        diversityKey: existing.diversityKey || sourceDiversityKey({ ...existing, ...source }, source.url || id),
        registrableDomain: existing.registrableDomain || registrableDomainFromUrl(source.url || id),
        tier: classifySourceTier(source, gap),
        clusterId: clusterById[id] || existing.clusterId || source.clusterId || null,
        status: existing.status || 'unread',
        freq: (existing.freq || 0) + 1,
      };
      const pooled = this.urlPool.add(record, { gapId, query, gap, clusterId: record.clusterId });
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
      && candidate.status !== 'duplicate'
      && (!gapId || candidate.gapId === gap.id)
    ));
    const alreadyRead = new Set(
      [...this.readSourceIds].map((id) => {
        const candidate = this.candidates.get(id);
        return sourceDiversityKey(candidate || { url: id }, candidate?.url || id);
      }).filter(Boolean),
    );
    return selectReadsByPolicy({
      candidates: unread,
      gap,
      alreadyReadHostnames: alreadyRead,
      maxPerHostname: MAX_CANDIDATES_PER_HOSTNAME,
      minCount: Math.min(2, count),
      maxCount: count,
    });
  }

  validate(action) {
    if (!ACTIONS.has(action?.action)) return 'unknown_action';
    const normalized = normalizeAction(action.action);
    if (this.maxSteps > 0 && this.step >= this.maxSteps && !FINALIZE_ACTIONS.has(action.action)) return 'max_steps';
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
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
    const secondaryOnly = this.profile?.evidenceScope === 'local'
      ? []
      : this.findings.flatMap((finding) => (finding.sources || [])
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
