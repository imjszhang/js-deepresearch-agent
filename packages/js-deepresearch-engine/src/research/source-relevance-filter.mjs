function dedupeSources(sources = []) {
  const seen = new Set();
  const unique = [];

  for (const source of sources) {
    const key = source.url || `${source.title}:${source.snippet}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }

  return unique;
}

function flattenSources(findings = []) {
  const flattened = [];
  for (const finding of findings) {
    for (const source of finding?.sources || []) {
      flattened.push(source);
    }
  }
  return dedupeSources(flattened);
}

function buildFilterPrompt(query, batch) {
  const items = batch.map((source, index) => (
    `${index + 1}. ${source.title || 'Untitled'}\nURL: ${source.url || ''}\nEvidence: ${source.summary || source.content || source.snippet || ''}`
  )).join('\n\n');

  return [
    {
      role: 'system',
      content: 'Return only JSON array. Each item: {"index": number, "keep": boolean, "score": number, "reason": string}.',
    },
    {
      role: 'user',
      content: [
        `Research query: ${query}`,
        '',
        'Rate source relevance:',
        items,
      ].join('\n'),
    },
  ];
}

function parseFilterResponse(raw = '', batchSize) {
  const match = String(raw).match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;

    const decisions = new Map();
    for (const item of parsed) {
      const index = Number(item.index);
      if (!Number.isFinite(index) || index < 1 || index > batchSize) continue;
      decisions.set(index, {
        keep: item.keep !== false,
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
        reason: String(item.reason || '').trim(),
      });
    }
    return decisions;
  } catch {
    return null;
  }
}

async function scoreBatch({ query, batch, llm, signal }) {
  const raw = await llm.complete({
    messages: buildFilterPrompt(query, batch),
    signal,
    temperature: 0,
    maxTokens: 800,
  });

  const decisions = parseFilterResponse(raw, batch.length);
  if (!decisions) {
    return batch.map((source) => ({ ...source, relevanceScore: 0.5 }));
  }

  return batch.map((source, index) => {
    const decision = decisions.get(index + 1) || { keep: true, score: 0.5, reason: '' };
    return {
      ...source,
      relevanceScore: decision.score,
      relevanceKeep: decision.keep,
      relevanceReason: decision.reason,
    };
  });
}

export async function filterFindingsByRelevance(findings = [], {
  query,
  llm,
  signal,
  enabled = false,
  maxSourcesForReport = 30,
} = {}) {
  if (!enabled) return findings;

  const flat = flattenSources(findings);
  if (flat.length === 0) return findings;

  const batchSize = 10;
  const scored = [];

  for (let index = 0; index < flat.length; index += batchSize) {
    const batch = flat.slice(index, index + batchSize);
    const batchScored = await scoreBatch({ query, batch, llm, signal });
    scored.push(...batchScored);
  }

  const kept = scored
    .filter((source) => source.relevanceKeep !== false)
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, maxSourcesForReport);

  const scoredByUrl = new Map(
    scored.filter((source) => source.url).map((source) => [source.url, source]),
  );
  const keptUrls = new Set(kept.map((source) => source.url).filter(Boolean));

  return findings.map((finding) => ({
    ...finding,
    sources: (finding.sources || [])
      .filter((source) => {
        if (!source.url) return false;
        return keptUrls.has(source.url);
      })
      .map((source) => {
        const scoredSource = scoredByUrl.get(source.url);
        return scoredSource ? { ...source, ...scoredSource } : source;
      }),
  })).filter((finding) => finding.sources.length > 0 || finding.error);
}
