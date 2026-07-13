function terms(value = '') {
  return new Set(String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
}

function score(query, document) {
  const wanted = terms(query);
  const available = terms(document);
  if (!wanted.size || !available.size) return 0;
  const overlap = [...wanted].filter((term) => available.has(term)).length;
  return overlap / Math.sqrt(wanted.size * available.size);
}

export class RulesRerankProvider {
  constructor(config = {}) {
    this.provider = 'rules';
    this.model = config.model || 'unicode-token-overlap-v1';
  }

  async rerank({ query, documents = [], topK, signal }) {
    signal?.throwIfAborted?.();
    const ranked = documents.map((document, originalIndex) => ({
      id: document.id,
      originalIndex,
      score: score(query, document.text),
    })).sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);
    return {
      items: Number(topK) > 0 ? ranked.slice(0, topK) : ranked,
      provider: this.provider,
      model: this.model,
      usage: { requests: 0, tokens: 0 },
      durationMs: 0,
      degraded: false,
    };
  }
}

export class DisabledRerankProvider {
  constructor() {
    this.provider = 'disabled';
    this.model = 'identity-v1';
  }

  async rerank({ documents = [], topK, signal }) {
    signal?.throwIfAborted?.();
    const items = documents.map((document, originalIndex) => ({ id: document.id, originalIndex, score: 0 }));
    return {
      items: Number(topK) > 0 ? items.slice(0, topK) : items,
      provider: this.provider,
      model: this.model,
      usage: { requests: 0, tokens: 0 },
      durationMs: 0,
      degraded: false,
    };
  }
}
