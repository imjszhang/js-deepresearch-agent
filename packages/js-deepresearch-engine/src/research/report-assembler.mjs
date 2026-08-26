import { classifyClaimSection } from './claim-quality.mjs';
import { getSourceEvidence, getSourceEvidenceClass } from './focused-settings.mjs';

function splitMarkdownSections(markdown) {
  const parts = [];
  let current = { heading: '', level: 0, lines: [] };
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (current.heading || current.lines.length) parts.push(current);
      current = { heading: match[2].trim(), level: match[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading || current.lines.length) parts.push(current);
  return parts;
}

function formatSection(part) {
  if (!part.heading) return part.lines.join('\n').trim();
  return `${'#'.repeat(Math.max(1, part.level))} ${part.heading}\n${part.lines.join('\n')}`.trim();
}

function isGeneratedHeading(heading) {
  const kind = classifyClaimSection(heading);
  return kind === 'source_entry' || ['evidence', '证据', 'analysis', '分析'].includes(String(heading || '').normalize('NFKC').trim().toLowerCase());
}

function isCaveatHeading(heading) {
  return classifyClaimSection(heading) === 'caveat';
}

export function keepNarrativeSections(narrative) {
  const kept = [];
  for (const part of splitMarkdownSections(narrative)) {
    if (!part.heading) {
      if (part.lines.some((line) => line.trim())) kept.push(formatSection(part));
      continue;
    }
    if (part.level === 1 || (!isGeneratedHeading(part.heading) && !isCaveatHeading(part.heading))) {
      kept.push(formatSection(part));
    }
  }
  return kept.join('\n\n').trim();
}

function extractNarrativeCaveats(narrative) {
  return splitMarkdownSections(narrative)
    .filter((part) => isCaveatHeading(part.heading))
    .flatMap((part) => part.lines.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean));
}

function citationKey(findingIndex, sourceIndex) {
  return `${findingIndex + 1}.${sourceIndex + 1}`;
}

export function renderEvidenceSection(findings = []) {
  const blocks = findings.map((finding, findingIndex) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    const items = sources.map((source, sourceIndex) => {
      const key = citationKey(findingIndex, sourceIndex);
      const klass = getSourceEvidenceClass(source);
      const text = getSourceEvidence(source) || 'No extracted evidence.';
      const title = source.title || source.url || key;
      return `*   **[${key}] ${title}** (${klass.replaceAll('_', ' ')}): ${text}`;
    });
    const question = finding.question || `Finding ${findingIndex + 1}`;
    return `### ${question}\n\n${items.join('\n') || '*   No sources.'}`;
  });
  return `## Evidence\n\n${blocks.join('\n\n') || 'No collected evidence.'}`;
}

export function renderSourcesSection(findings = []) {
  const lines = [];
  findings.forEach((finding, findingIndex) => {
    (finding.sources || []).forEach((source, sourceIndex) => {
      lines.push(`- [${citationKey(findingIndex, sourceIndex)}] ${source.title || 'Untitled'} | ${source.url || ''}`);
    });
  });
  return `## Sources\n\n${lines.join('\n') || '- No sources.'}`;
}

export function renderCaveatsSection(limitations = [], narrativeCaveats = []) {
  const items = [...new Set([...limitations, ...narrativeCaveats].map((item) => String(item || '').trim()).filter(Boolean))];
  const body = items.length
    ? items.map((item) => `- ${item}`).join('\n')
    : '- No additional caveats were recorded.';
  return `## Caveats\n\n${body}`;
}

export function assembleReport({
  narrative = '',
  findings = [],
  limitations = [],
  query = '',
} = {}) {
  const kept = keepNarrativeSections(narrative) || `# Research Report\n\n${query}`.trim();
  const caveats = renderCaveatsSection(limitations, extractNarrativeCaveats(narrative));
  return [kept, renderEvidenceSection(findings), caveats, renderSourcesSection(findings)]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function reviseUnsupportedKeyClaims(report, claims = []) {
  const weak = claims.filter((claim) => (
    claim.kind === 'key_claim'
    && ['unsupported', 'unverifiable'].includes(claim.evaluation?.verdict)
  ));
  let next = String(report || '');
  const moved = [];
  for (const claim of weak) {
    const text = String(claim.text || '').trim();
    if (!text || !next.includes(text)) continue;
    next = next.replace(text, '');
    moved.push(text);
  }
  next = next.replace(/(\n\s*){3,}/g, '\n\n');
  if (moved.length) {
    const extras = moved.map((text) => `- ${text}`).join('\n');
    if (/^##\s+(Caveats|局限|限制|注意事项)\b/im.test(next)) {
      next = next.replace(/^(##\s+(?:Caveats|局限|限制|注意事项)\b.*)/im, `$1\n\n${extras}`);
    } else {
      next = `${next.trim()}\n\n## Caveats\n\n${extras}`;
    }
  }
  return { report: next.trim(), moved };
}
