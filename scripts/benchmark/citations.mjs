const CITATION_PATTERN = /\[(\d+)\.(\d+)(?:-(\d+)\.(\d+))?\]/g;

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

function addCitationKey(citations, seen, findingIndex, sourceIndex) {
  const key = `${findingIndex}.${sourceIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  citations.push(key);
}

export function parseCitations(text = '') {
  const citations = [];
  const seen = new Set();

  for (const match of String(text).matchAll(CITATION_PATTERN)) {
    const findingStart = Number(match[1]);
    const sourceStart = Number(match[2]);
    const findingEnd = match[3] ? Number(match[3]) : findingStart;
    const sourceEnd = match[4] ? Number(match[4]) : sourceStart;

    if (match[3] && match[4]) {
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

    addCitationKey(citations, seen, findingStart, sourceStart);
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
