import { classifyClaimSection } from './claim-quality.mjs';
import { parseCitations } from './citations.mjs';

export const SOURCE_DUMP_LINE = /\[[0-9]+(?:\.[0-9]+)?\][^\n]*\((?:source body|snippet only|source summary)\)\s*:/i;

export function containsSourceDump(text = '') {
  return SOURCE_DUMP_LINE.test(String(text));
}

export function extractJsonObject(text = '') {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (
      typeof item === 'string' ? item.trim() : String(item?.text || '').trim()
    )).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function isWeakText(text = '') {
  const stripped = String(text)
    .replace(/[#*_`[\]()>]/g, '')
    .replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '');
  return stripped.length < 12;
}

const SUMMARY_HEADINGS = new Set(['summary', 'executive summary', '摘要', '总结', '概述']);

function normalizeHeading(title = '') {
  return String(title).normalize('NFKC').trim().toLowerCase().replace(/[：:]$/, '');
}

function isSummaryHeading(title = '') {
  const normalized = normalizeHeading(title);
  return SUMMARY_HEADINGS.has(normalized) || [...SUMMARY_HEADINGS].some((alias) => (
    normalized.startsWith(`${alias}:`) || normalized.startsWith(`${alias}：`)
  ));
}

function normalizeKeyFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? [{ heading: '', claims: [text] }] : [];
    }
    if (!item || typeof item !== 'object') return [];
    const heading = String(item.heading || item.title || '').trim();
    const claims = asStringList(item.claims || item.items);
    return claims.length ? [{ heading, claims }] : [];
  });
}

export function validateNarrativeObject(value, { requireCitedKeyFindings = false } = {}) {
  const flags = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, flags: ['narrative_not_object'], value: null };
  }
  if (value.evidence != null || value.sources != null || value.Evidence != null || value.Sources != null) {
    flags.push('narrative_has_generated_sections');
  }
  const title = String(value.title || '').trim();
  if (!title) flags.push('narrative_missing_title');
  const summary = asStringList(value.summary);
  if (!summary.length || summary.every((item) => isWeakText(item))) flags.push('narrative_empty_summary');
  const backgroundFacts = asStringList(value.backgroundFacts || value.confirmedBackgroundFacts);
  const keyFindings = normalizeKeyFindings(value.keyFindings);
  const citedFindings = keyFindings.flatMap((group) => group.claims).filter((claim) => parseCitations(claim).length > 0);
  const citedBackground = backgroundFacts.filter((claim) => parseCitations(claim).length > 0);
  const missingCited = requireCitedKeyFindings
    ? !citedFindings.length
    : (!citedFindings.length && !citedBackground.length);
  if (missingCited) flags.push('narrative_missing_cited_findings');
  const allTexts = [...summary, ...backgroundFacts, ...keyFindings.flatMap((group) => group.claims)];
  if (allTexts.some((item) => containsSourceDump(item))) flags.push('narrative_contains_source_dump');
  return {
    ok: flags.length === 0,
    flags,
    value: {
      title,
      summary,
      backgroundFacts,
      keyFindings,
      caveats: asStringList(value.caveats),
    },
  };
}

export function renderNarrativeMarkdown(narrative = {}) {
  const title = String(narrative.title || 'Research Report').trim() || 'Research Report';
  const summary = asStringList(narrative.summary).join('\n\n');
  const background = asStringList(narrative.backgroundFacts).map((item) => `- ${item}`).join('\n');
  const findings = (narrative.keyFindings || []).map((group) => {
    const heading = group.heading ? `### ${group.heading}\n` : '';
    const claims = asStringList(group.claims).map((claim) => `- ${claim}`).join('\n');
    return `${heading}${claims}`.trim();
  }).filter(Boolean).join('\n\n');
  const caveats = asStringList(narrative.caveats).map((item) => `- ${item}`).join('\n');
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    background ? `\n## Confirmed Background Facts\n${background}` : '',
    findings ? `\n## Key Findings\n${findings}` : '',
    caveats ? `\n## Caveats\n${caveats}` : '',
  ].filter((part) => part !== '').join('\n').trim();
}

const LIST_PREFIX = /^\s*(?:[-*]|\d+[.)])\s+/;

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

function extractBodyItems(lines = []) {
  const items = [];
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (text) items.push(text);
    paragraph = [];
  };
  for (const line of lines) {
    if (!String(line).trim()) {
      flush();
      continue;
    }
    if (LIST_PREFIX.test(line)) {
      flush();
      const item = String(line).replace(LIST_PREFIX, '').trim();
      if (item) items.push(item);
      continue;
    }
    paragraph.push(String(line).trim());
  }
  flush();
  return items;
}

export function parseMarkdownNarrative(markdown = '') {
  const parts = splitMarkdownSections(markdown);
  let title = 'Research Report';
  const summary = [];
  const backgroundFacts = [];
  const keyFindings = [];
  const caveats = [];
  let current = 'other';

  for (const part of parts) {
    if (part.level === 1 && part.heading) title = part.heading;
    const kind = classifyClaimSection(part.heading);
    if (kind === 'evidence_entry' || kind === 'source_entry') break;
    const items = extractBodyItems(part.lines);

    if (isSummaryHeading(part.heading)) {
      current = 'summary';
      summary.push(...items);
      continue;
    }
    if (kind === 'premise_fact') {
      current = 'background';
      backgroundFacts.push(...items);
      continue;
    }
    if (kind === 'key_claim' && part.level === 2 && !isSummaryHeading(part.heading)) {
      current = 'key_findings';
      if (items.length) keyFindings.push({ heading: '', claims: items });
      continue;
    }
    if (kind === 'caveat' && part.level <= 2) {
      current = 'caveats';
      caveats.push(...items);
      continue;
    }
    if (current === 'key_findings' && part.level >= 3) {
      keyFindings.push({ heading: part.heading, claims: items });
    }
  }

  return {
    title,
    summary,
    backgroundFacts,
    keyFindings,
    caveats,
    origin: 'markdown',
  };
}

export function normalizeNarrativeDocument(value = {}, { origin = 'object' } = {}) {
  const checked = validateNarrativeObject(value, { requireCitedKeyFindings: false });
  return {
    ...(checked.value || {
      title: String(value.title || 'Research Report'),
      summary: asStringList(value.summary),
      backgroundFacts: asStringList(value.backgroundFacts),
      keyFindings: normalizeKeyFindings(value.keyFindings),
      caveats: asStringList(value.caveats),
    }),
    origin,
    flags: checked.flags,
    ok: checked.ok,
  };
}

export function parseNarrativeResponse(text = '', options = {}) {
  const parsed = extractJsonObject(text);
  if (!parsed) return { ok: false, flags: ['narrative_not_json'], markdown: null, narrative: null };
  const checked = validateNarrativeObject(parsed, options);
  if (!checked.ok) {
    return {
      ok: false,
      flags: checked.flags,
      markdown: checked.value ? renderNarrativeMarkdown(checked.value) : null,
      narrative: checked.value,
    };
  }
  return {
    ok: true,
    flags: [],
    markdown: renderNarrativeMarkdown(checked.value),
    narrative: checked.value,
  };
}
