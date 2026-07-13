const ACTIONS = new Set(['search', 'read', 'reflect', 'answer', 'stop']);

export class ResearchState {
  constructor({ query, maxSteps = 12 }) {
    this.query = query;
    this.maxSteps = Math.max(1, Number(maxSteps) || 12);
    this.step = 0;
    this.gaps = [{ id: 'gap-1', question: query, status: 'open', priority: 'critical' }];
    this.findings = [];
    this.candidates = new Map();
    this.readSourceIds = new Set();
    this.observations = [];
    this.evaluationRetries = 0;
  }

  snapshot() {
    return {
      query: this.query,
      step: this.step,
      maxSteps: this.maxSteps,
      gaps: this.gaps,
      findingsCount: this.findings.length,
      candidates: [...this.candidates.values()].map(({ content, summary, ...candidate }) => ({
        ...candidate,
        hasContent: Boolean(content || summary),
      })),
      readSourceIds: [...this.readSourceIds],
      recentObservations: this.observations.slice(-6),
      evaluationRetries: this.evaluationRetries,
    };
  }

  addCandidates(sources, gapId) {
    for (const source of sources || []) {
      const id = source.id || source.url;
      if (!id) continue;
      const existing = this.candidates.get(id) || {};
      this.candidates.set(id, { ...existing, ...source, id, gapId: gapId || existing.gapId || 'gap-1' });
    }
  }

  validate(action) {
    if (!ACTIONS.has(action?.action)) return 'unknown_action';
    if (this.step >= this.maxSteps && !['answer', 'stop'].includes(action.action)) return 'max_steps';
    if (action.action === 'search' && !String(action.query || '').trim()) return 'missing_query';
    if (action.action === 'read') {
      if (!action.sourceIds?.length) return 'missing_source_ids';
      if (action.sourceIds.some((id) => !this.candidates.has(id))) return 'unknown_source';
    }
    if (action.action === 'answer' && this.findings.length === 0 && this.candidates.size === 0) return 'no_evidence';
    return null;
  }
}
