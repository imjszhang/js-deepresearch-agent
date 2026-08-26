const CITATION_BLOCK_PATTERN = /\[(\d+\.\d+(?:\s*(?:[-,，])\s*\d+\.\d+)*)\]/g;

function addCitationKey(citations, seen, findingIndex, sourceIndex) {
  const key = `${findingIndex}.${sourceIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  citations.push(key);
}

export function parseCitations(text = '') {
  const citations = [];
  const seen = new Set();

  for (const match of String(text).matchAll(CITATION_BLOCK_PATTERN)) {
    const body = match[1];
    const range = body.match(/^(\d+)\.(\d+)\s*-\s*(\d+)\.(\d+)$/);
    if (range) {
      const findingStart = Number(range[1]);
      const sourceStart = Number(range[2]);
      const findingEnd = Number(range[3]);
      const sourceEnd = Number(range[4]);
      if (findingStart === findingEnd) {
        for (let sourceIndex = sourceStart; sourceIndex <= sourceEnd; sourceIndex += 1) {
          addCitationKey(citations, seen, findingStart, sourceIndex);
        }
      } else {
        for (let findingIndex = findingStart; findingIndex <= findingEnd; findingIndex += 1) {
          for (let sourceIndex = sourceStart; sourceIndex <= sourceEnd; sourceIndex += 1) {
            addCitationKey(citations, seen, findingIndex, sourceIndex);
          }
        }
      }
      continue;
    }

    for (const part of body.split(/[,，]\s*/)) {
      const pair = part.match(/^(\d+)\.(\d+)$/);
      if (!pair) continue;
      addCitationKey(citations, seen, Number(pair[1]), Number(pair[2]));
    }
  }

  return citations;
}

export function buildCitationMap(findings = [], { sourceIdFor } = {}) {
  const map = new Map();

  findings.forEach((finding, findingIndex) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    sources.forEach((source, sourceIndex) => {
      const citationKey = `${findingIndex + 1}.${sourceIndex + 1}`;
      map.set(citationKey, {
        key: `[${citationKey}]`,
        citationKey,
        findingIndex: findingIndex + 1,
        sourceIndex: sourceIndex + 1,
        question: finding?.question || '',
        source,
        sourceId: source?.id || sourceIdFor?.(source) || null,
      });
    });
  });

  return map;
}

export function resolveCitations(citationKeys, citationMap) {
  const resolved = [];
  const unresolved = [];

  for (const key of citationKeys) {
    const entry = citationMap.get(key);
    if (entry) resolved.push(entry);
    else unresolved.push(key);
  }

  return { resolved, unresolved };
}

export function resolveCitedSourceIds(citationKeys = [], citationMap) {
  const { resolved, unresolved } = resolveCitations(citationKeys, citationMap);
  return {
    citedSourceIds: [...new Set(resolved.map((entry) => entry.sourceId).filter(Boolean))],
    unresolvedCitationKeys: unresolved,
    resolved,
  };
}
