const SUMMARY_ALIASES = ['summary', '摘要', '总结', '概述', 'executive summary', '结论', 'conclusion'];
const LIST_ALIASES = [
  'key findings', 'findings', 'evidence',
  '关键发现', '核心发现', '主要发现', '证据',
];
const SKIP_ALIASES = ['sources', 'source list', '主要来源', '参考文献', '引用来源'];

const CITATION_PATTERN = /\[\d+\.\d+(?:-\d+\.\d+)?\]/;

function normalizeHeading(value = '') {
  return String(value).trim().toLowerCase();
}

function stripLeadingNumber(value = '') {
  return String(value).replace(/^\d+(?:\.\d+)*[.)]\s*/, '').trim();
}

function matchesAlias(heading, aliases) {
  const normalized = normalizeHeading(heading);
  const stripped = normalizeHeading(stripLeadingNumber(heading));
  return aliases.some((alias) => normalized === alias || stripped === alias
    || stripped.startsWith(`${alias}：`)
    || stripped.startsWith(`${alias}:`));
}

function classifySection(heading) {
  if (matchesAlias(heading, SKIP_ALIASES)) return 'skip';
  if (matchesAlias(heading, SUMMARY_ALIASES)) return 'summary';
  if (matchesAlias(heading, LIST_ALIASES)) return 'list';
  return 'body';
}

function stripMarkdown(text = '') {
  return String(text)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function isListItem(line = '') {
  return /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

function extractListItemText(line = '') {
  return stripMarkdown(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim());
}

function isSkippableLine(line = '') {
  const trimmed = line.trim();
  return !trimmed
    || trimmed.startsWith('|')
    || /^-{3,}$/.test(trimmed)
    || trimmed.startsWith('```');
}

function hasCitation(text = '') {
  return CITATION_PATTERN.test(text);
}

function pushClaim(claims, seen, claim) {
  const text = stripMarkdown(String(claim.text || '').trim());
  if (!text || text.length < 8) return;
  if (seen.has(text)) return;
  seen.add(text);
  claims.push({
    section: claim.section,
    text,
    lineStart: claim.lineStart,
  });
}

export function extractClaims(report = '') {
  const lines = String(report).split(/\r?\n/);
  const claims = [];
  const seen = new Set();
  let currentSection = 'Introduction';
  let sectionMode = 'body';
  let currentClaim = null;

  function flushClaim() {
    if (!currentClaim) return;
    pushClaim(claims, seen, currentClaim);
    currentClaim = null;
  }

  function beginSection(label) {
    flushClaim();
    currentSection = label;
    sectionMode = classifySection(label);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const h2Match = line.match(/^##\s+(.+)$/);
    const h3Match = !h2Match && line.match(/^###\s+(.+)$/);

    if (h2Match) {
      beginSection(h2Match[1].trim());
      continue;
    }

    if (h3Match) {
      beginSection(h3Match[1].trim());
      continue;
    }

    if (sectionMode === 'skip' || isSkippableLine(line)) {
      if (sectionMode !== 'skip' && !line.trim()) flushClaim();
      continue;
    }

    if (isListItem(line)) {
      flushClaim();
      const text = extractListItemText(line);
      if (sectionMode === 'list' || (sectionMode === 'body' && hasCitation(text))) {
        pushClaim(claims, seen, {
          section: currentSection,
          text,
          lineStart: index + 1,
        });
      }
      continue;
    }

    if (sectionMode === 'summary') {
      if (!line.trim()) {
        flushClaim();
        continue;
      }
      if (!currentClaim) {
        currentClaim = {
          section: currentSection,
          text: line.trim(),
          lineStart: index + 1,
        };
      } else {
        currentClaim.text += ` ${line.trim()}`;
      }
      continue;
    }

    if (sectionMode === 'list') {
      if (line.trim()) {
        pushClaim(claims, seen, {
          section: currentSection,
          text: line.trim(),
          lineStart: index + 1,
        });
      }
      continue;
    }

    if (sectionMode === 'body' && line.trim() && hasCitation(line)) {
      flushClaim();
      pushClaim(claims, seen, {
        section: currentSection,
        text: line.trim(),
        lineStart: index + 1,
      });
    }
  }

  flushClaim();
  return claims;
}
