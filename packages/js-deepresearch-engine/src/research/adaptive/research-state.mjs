import { ActionCostTracker, buildBudgetView, estimateReportPromptTokens } from './budget-view.mjs';
import {
  evaluateExploratorySufficiency,
  similarQuestions,
  sourceHasBody,
} from './exploratory-sufficiency.mjs';

const ACTIONS = new Set(['search', 'read', 'reflect', 'answer', 'stop']);
const RANKED_CANDIDATE_LIMIT = 20;
const SNAPSHOT_CANDIDATE_LIMIT = 8;
const MAX_CANDIDATES_PER_HOSTNAME = 2;
const KNOWLEDGE_SNIPPET_CHARS = 160;
const DIARY_SNAPSHOT_LINES = 12;

// Official repos and documentation hosts tend to carry primary evidence.
const BOOST_HOSTNAME_PATTERNS = [
  /(^|\.)github\.com$/,
  /(^|\.)gitlab\.com$/,
  /\.readthedocs\.io$/,
  /^docs\./,
  /(^|\.)wikipedia\.org$/,
];
// Download portals, app stores, and shopping sites rarely answer research questions.
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

export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function hostnameWeight(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return 0;
  if (PENALIZE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_PENALTY;
  if (BOOST_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) return HOSTNAME_BOOST;
  return 0;
}

export class ResearchState {
  constructor({ query, maxSteps = 12, maxGapDepth = 2, targetLlmTokens = 0, budget = null } = {}) {
    this.query = query;
    this.maxSteps = Math.max(1, Number(maxSteps) || 12);
    this.maxGapDepth = Math.max(0, Number(maxGapDepth) || 0);
    this.targetLlmTokens = Number(targetLlmTokens) || 0;
    this.budgetManager = budget;
    this.actionCosts = new ActionCostTracker();
    this.budgetView = null;
    this.sufficiency = null;
    this.step = 0;
    this.lastAction = null;
    this.gaps = [{ id: 'gap-1', question: query, status: 'open', priority: 'critical', depth: 0 }];
    this.findings = [];
    this.candidates = new Map();
    this.readSourceIds = new Set();
    this.knowledge = [];
    this.observations = [];
    this.diary = [];
    this.evaluationRetries = 0;
  }

  addDiary(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.diary.push(`step ${this.step}: ${text}`);
  }

  addGap(question, priority = 'normal', { depth } = {}) {
    const text = String(question || '').trim();
    if (!text) return null;
    if (this.gaps.some((gap) => similarQuestions(gap.question, text))) return null;
    const nextDepth = depth ?? 1;
    if (this.maxGapDepth > 0 && nextDepth > this.maxGapDepth) return null;
    const gap = { id: `gap-${this.gaps.length + 1}`, question: text, status: 'open', priority, depth: nextDepth };
    this.gaps.push(gap);
    return gap;
  }

  gapCovered(gapId) {
    return this.findings.some((finding) => finding.gapId === gapId
      && (finding.sources || []).some(sourceHasBody));
  }

  hasBodyEvidence() {
    return this.findings.some((finding) => (finding.sources || []).some(sourceHasBody));
  }

  syncGapCoverage() {
    for (const gap of this.gaps) {
      if (this.gapCovered(gap.id) && gap.status === 'open') {
        gap.status = 'resolved';
        gap.resolvedAtStep = this.step;
      }
    }
  }

  refreshBudgetView({ budget, targetLlmTokens, actionCosts } = {}) {
    const manager = budget || this.budgetManager;
    if (manager) {
      if (targetLlmTokens !== undefined) {
        manager.targetLlmTokens = Number(targetLlmTokens) || 0;
        this.targetLlmTokens = manager.targetLlmTokens;
      } else if (this.targetLlmTokens && !manager.targetLlmTokens) {
        manager.targetLlmTokens = this.targetLlmTokens;
      }
      manager.updateReportReserve(estimateReportPromptTokens({ query: this.query, findings: this.findings }));
      this.budgetView = buildBudgetView({
        budget: manager,
        actionCosts: actionCosts || this.actionCosts,
        targetLlmTokens: manager.targetLlmTokens,
      });
    }
    this.syncGapCoverage();
    this.sufficiency = evaluateExploratorySufficiency({
      query: this.query,
      findings: this.findings,
      gaps: this.gaps,
      state: this,
    });
    return this.budgetView;
  }

  focusGap() {
    const open = this.gaps.filter((gap) => gap.status === 'open' && !this.gapCovered(gap.id));
    const pool = open.length ? open : this.gaps.filter((gap) => gap.status === 'open');
    if (!pool.length) return this.gaps[0];
    return pool[this.step % pool.length];
  }

  searchedQueries() {
    return [...new Set(this.observations
      .filter((observation) => observation.type === 'search_result')
      .map((observation) => observation.query)
      .filter(Boolean))];
  }

  addKnowledge({ gapId, sourceId, learned }) {
    const text = String(learned || '').trim();
    if (!text) return;
    this.knowledge.push({ gapId: gapId || 'gap-1', sourceId: sourceId || null, learned: text.slice(0, KNOWLEDGE_SNIPPET_CHARS) });
  }

  candidateScore(candidate) {
    return (candidate.rerank?.score || 0) + (candidate.freq || 0) * 0.1 + hostnameWeight(candidate.url);
  }

  rankedCandidates() {
    const ranked = [...this.candidates.values()].sort((a, b) => this.candidateScore(b) - this.candidateScore(a));
    const perHostname = new Map();
    const selected = [];
    for (const candidate of ranked) {
      const hostname = hostnameOf(candidate.url);
      const count = perHostname.get(hostname) || 0;
      if (hostname && count >= MAX_CANDIDATES_PER_HOSTNAME && !this.readSourceIds.has(candidate.id)) continue;
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
      stepsRemaining: Math.max(0, this.maxSteps - this.step),
      lastAction: this.lastAction,
      gaps,
      focusGapId: this.focusGap()?.id || 'gap-1',
      findingsCount: this.findings.length,
      bodyEvidenceCoverage: {
        hasBodyEvidence: this.hasBodyEvidence(),
        resolvedGaps: gaps.filter((gap) => gap.covered || gap.status === 'resolved').map((gap) => gap.id),
        openGaps: gaps.filter((gap) => gap.status === 'open' && !gap.covered).map((gap) => gap.id),
      },
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
      qualityGate: this.sufficiency ? {
        sufficient: this.sufficiency.sufficient,
        inconclusive: this.sufficiency.inconclusive,
        flags: this.sufficiency.flags,
        decision: this.sufficiency.decision,
        method: this.sufficiency.method,
      } : null,
    };
  }

  addCandidates(sources, gapId) {
    for (const source of sources || []) {
      const id = source.id || source.url;
      if (!id) continue;
      const existing = this.candidates.get(id) || {};
      this.candidates.set(id, {
        ...existing,
        ...source,
        id,
        gapId: gapId || existing.gapId || 'gap-1',
        freq: (existing.freq || 0) + 1,
      });
    }
  }

  validate(action) {
    if (!ACTIONS.has(action?.action)) return 'unknown_action';
    if (this.step >= this.maxSteps && !['answer', 'stop'].includes(action.action)) return 'max_steps';
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
      if (this.lastAction === 'read') {
        const unread = action.sourceIds.filter((id) => !this.readSourceIds.has(id));
        if (!unread.length) return 'repeat_action';
      }
    }
    if (action.action === this.lastAction && !['answer', 'stop', 'read', 'search'].includes(action.action)) {
      return 'repeat_action';
    }
    if (action.action === 'answer' && this.lastAction === 'search' && !this.hasBodyEvidence()) {
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
    }
    if (action.action === 'reflect') {
      const question = String(action.gapQuestion || '').trim();
      if (question && this.gaps.some((gap) => similarQuestions(gap.question, question))) return 'repeat_gap';
    }
    if (action.action === 'answer' && this.findings.length === 0 && this.candidates.size === 0) return 'no_evidence';
    return null;
  }
}
