const CITATION_PATTERN = /\[(\d+)\.(\d+)\]/g;

export function buildCitationMap(findings = []) {
  const map = new Map();

  findings.forEach((finding, findingIndex) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    sources.forEach((source, sourceIndex) => {
      map.set(`${findingIndex + 1}.${sourceIndex + 1}`, {
        key: `[${findingIndex + 1}.${sourceIndex + 1}]`,
        findingIndex: findingIndex + 1,
        sourceIndex: sourceIndex + 1,
        question: finding?.question || '',
        source,
      });
    });
  });

  return map;
}

export function parseCitations(text = '') {
  const citations = [];
  const seen = new Set();

  for (const match of String(text).matchAll(CITATION_PATTERN)) {
    const key = `${match[1]}.${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push(key);
    }
  }

  return citations;
}

export function resolveCitations(citationKeys, citationMap) {
  const resolved = [];
  const unresolved = [];

  for (const key of citationKeys) {
    const entry = citationMap.get(key);
    if (entry) {
      resolved.push(entry);
    } else {
      unresolved.push(key);
    }
  }

  return { resolved, unresolved };
}
