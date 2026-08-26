import { parseCitations } from './citations.mjs';
import { containsSourceDump } from './report-assembler.mjs';

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
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function isWeakText(text = '') {
  const stripped = String(text)
    .replace(/[#*_`[\]()>]/g, '')
    .replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '');
  return stripped.length < 12;
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

export function validateNarrativeObject(value) {
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
  const keyFindings = normalizeKeyFindings(value.keyFindings);
  const citedFindings = keyFindings.flatMap((group) => group.claims).filter((claim) => parseCitations(claim).length > 0);
  if (!citedFindings.length) flags.push('narrative_missing_cited_findings');
  const allTexts = [...summary, ...keyFindings.flatMap((group) => group.claims)];
  if (allTexts.some((item) => containsSourceDump(item))) flags.push('narrative_contains_source_dump');
  return {
    ok: flags.length === 0,
    flags,
    value: {
      title,
      summary,
      keyFindings,
      caveats: asStringList(value.caveats),
    },
  };
}

export function renderNarrativeMarkdown(narrative = {}) {
  const title = String(narrative.title || 'Research Report').trim() || 'Research Report';
  const summary = asStringList(narrative.summary).map((item) => item).join('\n\n');
  const findings = (narrative.keyFindings || []).map((group) => {
    const heading = group.heading ? `### ${group.heading}\n` : '';
    const claims = (group.claims || []).map((claim) => `- ${claim}`).join('\n');
    return `${heading}${claims}`.trim();
  }).filter(Boolean).join('\n\n');
  const caveats = asStringList(narrative.caveats).map((item) => `- ${item}`).join('\n');
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Key Findings',
    findings,
    caveats ? `\n## Caveats\n${caveats}` : '',
  ].filter((part) => part !== '').join('\n').trim();
}

export function parseNarrativeResponse(text = '') {
  const parsed = extractJsonObject(text);
  if (!parsed) return { ok: false, flags: ['narrative_not_json'], markdown: null };
  const checked = validateNarrativeObject(parsed);
  if (!checked.ok) return { ok: false, flags: checked.flags, markdown: null };
  return { ok: true, flags: [], markdown: renderNarrativeMarkdown(checked.value), narrative: checked.value };
}
