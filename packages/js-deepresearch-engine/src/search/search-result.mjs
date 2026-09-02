const SEARCH_META = Symbol.for('jdr.searchMeta');

export function attachSearchMeta(sources, meta = {}) {
  const list = Array.isArray(sources) ? sources : [];
  Object.defineProperty(list, SEARCH_META, {
    value: meta && typeof meta === 'object' ? meta : {},
    enumerable: false,
    configurable: true,
  });
  return list;
}

export function getSearchMeta(sources) {
  if (!sources || typeof sources !== 'object') return null;
  return sources[SEARCH_META] || null;
}

export function compactSearchSnippets(sources = [], limit = 3) {
  return (sources || []).slice(0, Math.max(0, Number(limit) || 0)).map((source) => ({
    title: String(source?.title || '').slice(0, 120),
    url: source?.url || '',
    snippet: String(source?.snippet || '').slice(0, 200),
    engines: Array.isArray(source?.engines) ? source.engines : undefined,
  }));
}

export function collectRespondedEngines(sources = []) {
  return unique((sources || []).flatMap((source) => (
    Array.isArray(source?.engines) ? source.engines : []
  )));
}

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}
