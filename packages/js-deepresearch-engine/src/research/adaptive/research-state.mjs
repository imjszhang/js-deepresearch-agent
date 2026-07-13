const ACTIONS = new Set(['search', 'read', 'reflect', 'answer', 'stop']);
const SNAPSHOT_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATES_PER_HOSTNAME = 2;
const KNOWLEDGE_SNIPPET_CHARS = 160;
const SNIPPET_SNAPSHOT_CHARS = 200;

export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export class ResearchState {
  constructor({ query, maxSteps = 12 }) {
    this.query = query;
    this.maxSteps = Math.max(1, Number(maxSteps) || 12);
    this.step = 0;
    this.lastAction = null;
    this.gaps = [{ id: 'gap-1', question: query, status: 'open', priority: 'critical' }];
    this.findings = [];
    this.candidates = new Map();
    this.readSourceIds = new Set();
    this.knowledge = [];
    this.observations = [];
    this.evaluationRetries = 0;
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

  rankedCandidates() {
    const ranked = [...this.candidates.values()].sort((a, b) => (
      ((b.rerank?.score || 0) - (a.rerank?.score || 0))
      || ((b.freq || 0) - (a.freq || 0))
    ));
    const perHostname = new Map();
    const selected = [];
    for (const candidate of ranked) {
      const hostname = hostnameOf(candidate.url);
      const count = perHostname.get(hostname) || 0;
      if (hostname && count >= MAX_CANDIDATES_PER_HOSTNAME && !this.readSourceIds.has(candidate.id)) continue;
      perHostname.set(hostname, count + 1);
      selected.push(candidate);
      if (selected.length >= SNAPSHOT_CANDIDATE_LIMIT) break;
    }
    return selected;
  }

  snapshot() {
    return {
      query: this.query,
      step: this.step,
      maxSteps: this.maxSteps,
      stepsRemaining: Math.max(0, this.maxSteps - this.step),
      lastAction: this.lastAction,
      gaps: this.gaps,
      findingsCount: this.findings.length,
      candidates: this.rankedCandidates().map((candidate) => ({
        id: candidate.id,
        url: candidate.url,
        title: candidate.title,
        snippet: String(candidate.snippet || '').slice(0, SNIPPET_SNAPSHOT_CHARS),
        gapId: candidate.gapId,
        freq: candidate.freq || 1,
        rerank: candidate.rerank || null,
        fetchStatus: candidate.fetchStatus || null,
        hasContent: Boolean(candidate.content || candidate.summary),
      })),
      readSourceIds: [...this.readSourceIds],
      searchedQueries: this.searchedQueries(),
      knowledge: this.knowledge,
      recentObservations: this.observations.slice(-6),
      evaluationRetries: this.evaluationRetries,
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
    if (action.action === this.lastAction && !['answer', 'stop'].includes(action.action)) {
      const lastSearch = [...this.observations].reverse().find((observation) => observation.type === 'search_result');
      const emptySearchRetry = action.action === 'search' && lastSearch?.resultCount === 0;
      if (!emptySearchRetry) return 'repeat_action';
    }
    if (action.action === 'answer' && this.lastAction === 'search') return 'answer_after_search';
    if (action.action === 'search' && !String(action.query || '').trim()) return 'missing_query';
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
    }
    if (action.action === 'answer' && this.findings.length === 0 && this.candidates.size === 0) return 'no_evidence';
    return null;
  }
}
