import crypto from 'node:crypto';

export function normalizeWikiSource(input, index = 0) {
  const researchId = input.researchId ?? input._researchId ?? 'unknown';
  const sourceIndex = input.sourceIndex ?? input.index ?? index + 1;
  const id = input.id ?? `${researchId}/source-${String(sourceIndex).padStart(3, '0')}`;

  return {
    id,
    kind: input.kind ?? 'research-source',
    title: input.title ?? '',
    url: input.url ?? '',
    snippet: input.snippet ?? '',
    content: input.content ?? input.summary ?? '',
    researchId,
    query: input.query ?? '',
    strategy: input.strategy ?? '',
    sourceIndex,
    artifactPaths: input.artifactPaths ?? {},
    tags: Array.isArray(input.tags) ? input.tags : ['source'],
    observedAt: input.observedAt ?? new Date().toISOString(),
    engine: input.engine ?? '',
  };
}

export function hashSource(source) {
  const payload = {
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    content: source.content,
    researchId: source.researchId,
    query: source.query,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function groupSourcesByResearch(sources) {
  const groups = new Map();
  for (const raw of sources) {
    const source = normalizeWikiSource(raw);
    const list = groups.get(source.researchId) ?? [];
    list.push(source);
    groups.set(source.researchId, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.sourceIndex - b.sourceIndex);
  }
  return groups;
}
