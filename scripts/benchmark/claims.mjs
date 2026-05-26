const TARGET_SECTIONS = new Set(['summary', 'key findings', 'evidence']);

function normalizeHeading(value = '') {
  return String(value).trim().toLowerCase();
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

export function extractClaims(report = '') {
  const lines = String(report).split(/\r?\n/);
  const claims = [];
  let currentSection = null;
  let currentClaim = null;

  function flushClaim() {
    if (!currentClaim) return;
    const text = stripMarkdown(currentClaim.text.trim());
    if (text) {
      claims.push({
        section: currentClaim.section,
        text,
        lineStart: currentClaim.lineStart,
      });
    }
    currentClaim = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^##\s+(.+)$/);

    if (headingMatch) {
      flushClaim();
      const heading = normalizeHeading(headingMatch[1]);
      currentSection = TARGET_SECTIONS.has(heading) ? headingMatch[1].trim() : null;
      continue;
    }

    if (!currentSection) continue;

    if (isListItem(line)) {
      flushClaim();
      currentClaim = {
        section: currentSection,
        text: extractListItemText(line),
        lineStart: index + 1,
      };
      continue;
    }

    if (currentSection === 'Summary' && line.trim()) {
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

    if (currentClaim && line.trim().startsWith('- ')) {
      flushClaim();
      currentClaim = {
        section: currentSection,
        text: extractListItemText(line),
        lineStart: index + 1,
      };
      continue;
    }

    if (currentClaim && line.trim()) {
      currentClaim.text += ` ${line.trim()}`;
    }
  }

  flushClaim();
  return claims;
}
