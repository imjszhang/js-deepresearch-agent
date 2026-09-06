import { classifyClaimSection } from './claim-quality.mjs';
import { getSourceEvidenceClass } from './focused-settings.mjs';
import { DEFAULT_MAX_PASSAGE_CHARS, selectDisplayedEvidence } from './evidence-chain.mjs';
import {
  containsSourceDump,
  parseMarkdownNarrative,
  renderNarrativeMarkdown,
} from './report-narrative.mjs';

export { containsSourceDump, SOURCE_DUMP_LINE } from './report-narrative.mjs';

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

function normalizeComparable(value = '') {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function looksLikeDumpSection(part = {}, query = '') {
  const heading = normalizeComparable(part.heading || '');
  const body = Array.isArray(part.lines) ? part.lines.join('\n') : String(part.body || '');
  if (containsSourceDump(body)) return true;
  const normalizedQuery = normalizeComparable(query);
  if (normalizedQuery && heading && heading === normalizedQuery) return true;
  return heading.length > 80 && containsSourceDump(body);
}

function isGeneratedHeading(heading) {
  const kind = classifyClaimSection(heading);
  return kind === 'source_entry' || kind === 'evidence_entry';
}

function isCaveatHeading(heading) {
  return classifyClaimSection(heading) === 'caveat';
}

export function keepNarrativeSections(narrative, { query = '' } = {}) {
  const kept = [];
  for (const part of splitMarkdownSections(narrative)) {
    if (!part.heading) {
      if (part.lines.some((line) => line.trim()) && !containsSourceDump(part.lines.join('\n'))) {
        kept.push(formatSection(part));
      }
      continue;
    }
    const generated = isGeneratedHeading(part.heading) || isCaveatHeading(part.heading);
    if (generated && part.level <= 2) break;
    if (generated) continue;
    if (looksLikeDumpSection(part, query)) continue;
    if (part.level === 1 || !isGeneratedHeading(part.heading)) {
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

export function renderEvidenceSection(findings = [], {
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const blocks = findings.map((finding, findingIndex) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    const items = sources.map((source, sourceIndex) => {
      const key = citationKey(findingIndex, sourceIndex);
      const klass = getSourceEvidenceClass(source);
      const text = selectDisplayedEvidence(source, { passages, maxChars: maxPassageChars }) || 'No extracted evidence.';
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
      const provenance = [
        source.publisher && `publisher: ${source.publisher}`,
        source.author && `author: ${source.author}`,
        source.publishedAt && `published: ${source.publishedAt}`,
        source.updatedAt && `updated: ${source.updatedAt}`,
        source.accessedAt && `accessed: ${source.accessedAt}`,
        source.sourceType && `type: ${source.sourceType}`,
        source.jurisdiction && `jurisdiction: ${source.jurisdiction}`,
        source.productVersion && `version: ${source.productVersion}`,
        source.accessStatus && `access: ${source.accessStatus}`,
      ].filter(Boolean);
      lines.push(`- [${citationKey(findingIndex, sourceIndex)}] ${source.title || 'Untitled'} | ${source.url || ''}${provenance.length ? ` | ${provenance.join('; ')}` : ''}`);
    });
  });
  return `## Sources\n\n${lines.join('\n') || '- No sources.'}`;
}

const INSUFFICIENT_EVIDENCE_PREFIX = /^(?:insufficient direct evidence for:\s*)/i;

export function normalizeCaveatKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(INSUFFICIENT_EVIDENCE_PREFIX, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.!?！？]+$/g, '')
    .toLowerCase();
}

export function renderCaveatsSection(limitations = [], narrativeCaveats = []) {
  const seen = new Set();
  const items = [];
  for (const item of [...limitations, ...narrativeCaveats]) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = normalizeCaveatKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
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
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const kept = keepNarrativeSections(narrative, { query }) || `# Research Report\n\n${query}`.trim();
  const caveats = renderCaveatsSection(limitations, extractNarrativeCaveats(narrative));
  return [
    kept,
    renderEvidenceSection(findings, { passages, maxPassageChars }),
    caveats,
    renderSourcesSection(findings),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

const LIST_PREFIX = /^\s*(?:[-*]|\d+[.)])\s+/;
const WEAK_CLAIM_FLAGS = new Set([
  'uncited',
  'snippet_only',
  'unresolved_citation',
  'missing_direct_evidence',
  'slot_blocked',
  'slot_limited',
  'slot_premise_rejected',
]);

function claimHasSourceContent(claim = {}) {
  return (claim.evidence || []).some((item) => {
    if (!item?.passageId) return false;
    const origin = String(item.origin || item.evidenceOrigin || '').toLowerCase();
    return origin !== 'search_snippet' && origin !== 'snippet';
  });
}

export function shouldMoveWeakPremiseFact(claim = {}) {
  if (claim.kind !== 'premise_fact') return false;
  const flags = claim.evaluation?.flags || claim.flags || [];
  const verdict = claim.evaluation?.verdict;
  if (flags.includes('slot_premise_exempt') && (verdict === 'supported' || verdict === 'partially_supported')) {
    return false;
  }
  if (flags.includes('slot_premise_rejected')) return true;
  if (flags.some((flag) => WEAK_CLAIM_FLAGS.has(flag))) return true;
  if (verdict === 'unsupported' || verdict === 'conflicting') return true;
  if (claimHasSourceContent(claim) && (!verdict || verdict === 'supported' || verdict === 'partially_supported' || verdict === 'unverifiable')) {
    return false;
  }
  if (verdict && verdict !== 'supported' && verdict !== 'partially_supported') return true;
  return false;
}

export function shouldMoveWeakKeyClaim(claim = {}) {
  if (claim.kind === 'premise_fact') return shouldMoveWeakPremiseFact(claim);
  if (claim.kind !== 'key_claim') return false;
  const flags = claim.evaluation?.flags || claim.flags || [];
  if (flags.includes('slot_premise_exempt') || flags.includes('slot_fact_exempt')) return false;
  if (flags.some((flag) => ['slot_blocked', 'slot_limited'].includes(flag))) return true;
  const verdict = claim.evaluation?.verdict;
  if (verdict === 'unsupported') return true;
  if (verdict !== 'unverifiable') return false;
  if (claimHasSourceContent(claim)) return false;
  const cited = Boolean(
    claim.citedSourceId
    || (claim.citedSourceIds || []).length
    || (claim.citationKeys || []).length
    || (claim.evidence || []).length,
  );
  const snippetLike = new Set(['snippet_only', 'missing_direct_evidence']);
  const otherWeak = flags.filter((flag) => !snippetLike.has(flag));
  if (otherWeak.some((flag) => WEAK_CLAIM_FLAGS.has(flag))) return true;
  if (flags.some((flag) => snippetLike.has(flag))) return !cited;
  return !cited;
}

const SUMMARY_HEADINGS = new Set(['summary', 'executive summary', '摘要', '总结', '概述']);
const INCOMPLETE_SUMMARY = 'Required answer slots remain limited or blocked. Confirmed facts appear only where dedicated evidence was verified; unsupported conclusions were moved to Caveats and must not be treated as findings. See Caveats for the remaining open slots.';

function isSummaryHeading(title = '') {
  const normalized = String(title).normalize('NFKC').trim().toLowerCase().replace(/[：:]$/, '');
  return SUMMARY_HEADINGS.has(normalized);
}

function summarySectionIsPlaceholder(report) {
  const lines = String(report || '').split('\n');
  const body = [];
  let capture = false;
  let captureLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      if (isSummaryHeading(heading[2].trim())) {
        capture = true;
        captureLevel = level;
        continue;
      }
      if (capture && level <= captureLevel) break;
    }
    if (capture) body.push(line);
  }
  const stripped = body.join('\n').replace(/[#*_`[\]()>]/g, '').replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '');
  return stripped.length < 12;
}

function insertAfterSummaryHeading(report, sentence) {
  const lines = String(report || '').split('\n');
  const next = [];
  let inserted = false;
  for (const line of lines) {
    next.push(line);
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (!inserted && heading && isSummaryHeading(heading[1].trim())) {
      next.push('');
      next.push(sentence);
      next.push('');
      inserted = true;
    }
  }
  return inserted ? next.join('\n') : `${String(report || '').trim()}\n\n## Summary\n\n${sentence}\n`;
}

function ensureNarrativeAfterRevision(report) {
  if (!summarySectionIsPlaceholder(report)) return report;
  return insertAfterSummaryHeading(report, INCOMPLETE_SUMMARY);
}

function sectionBodyIsEmpty(part) {
  const body = (part.lines || []).join('\n').trim();
  if (!body) return true;
  const stripped = body.replace(/[#*_`[\]()>]/g, '').replace(/[；;。.!?！？,，、\s…\-–—:：]/g, '');
  return stripped.length < 4;
}

export function stripEmptyNarrativeSections(markdown = '') {
  const parts = splitMarkdownSections(markdown);
  const kept = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const kind = classifyClaimSection(part.heading);
    if (part.level >= 3 && sectionBodyIsEmpty(part)) continue;
    if (part.level === 2 && kind === 'key_claim' && !isSummaryHeading(part.heading) && sectionBodyIsEmpty(part)) {
      const descendants = [];
      for (let child = index + 1; child < parts.length; child += 1) {
        if (parts[child].level <= 2) break;
        descendants.push(parts[child]);
      }
      if (!descendants.some((item) => !sectionBodyIsEmpty(item))) continue;
    }
    kept.push(formatSection(part));
  }
  return kept.join('\n\n').trim();
}

function claimTextMatches(item, text) {
  const value = normalizeComparable(String(item || '').replace(LIST_PREFIX, ''));
  const target = normalizeComparable(text);
  if (!value || !target) return false;
  if (value === target) return true;
  if (value.startsWith(target)) {
    const next = value[target.length];
    return !next || /[\s.。，,;；[]/.test(next);
  }
  return false;
}

function removeMatchingTexts(list = [], text) {
  const next = [];
  let removed = false;
  for (const item of list) {
    if (claimTextMatches(item, text)) {
      removed = true;
      continue;
    }
    next.push(item);
  }
  return { list: next, removed };
}

function isSummaryPlacement(claim = {}) {
  return isSummaryHeading(claim.section) || (claim.placements || []).includes('summary');
}

export function reviseNarrativeDocument(document = {}, claims = []) {
  let summary = [...(document.summary || [])];
  let backgroundFacts = [...(document.backgroundFacts || [])];
  let keyFindings = (document.keyFindings || []).map((group) => ({
    heading: group.heading || '',
    claims: (group.claims || []).map((claim) => (typeof claim === 'string' ? claim : claim.text)).filter(Boolean),
  }));
  const moved = [];
  const relocated = [];

  const removeEverywhere = (text, { includeBackground = false } = {}) => {
    const fromSummary = removeMatchingTexts(summary, text);
    summary = fromSummary.list;
    const nextGroups = [];
    let fromFindings = false;
    for (const group of keyFindings) {
      const result = removeMatchingTexts(group.claims, text);
      fromFindings = fromFindings || result.removed;
      if (result.list.length) nextGroups.push({ ...group, claims: result.list });
    }
    keyFindings = nextGroups;
    let fromBackground = false;
    if (includeBackground) {
      const result = removeMatchingTexts(backgroundFacts, text);
      backgroundFacts = result.list;
      fromBackground = result.removed;
    }
    return fromSummary.removed || fromFindings || fromBackground;
  };

  for (const claim of claims) {
    const flags = claim.evaluation?.flags || claim.flags || [];
    if (claim.kind !== 'key_claim' || !flags.includes('slot_fact_exempt')) continue;
    const text = String(claim.text || '').trim();
    if (!text) continue;
    const removalText = String(isSummaryPlacement(claim) ? (claim.parentClaimText || text) : text).trim();
    if (!removeEverywhere(removalText)) continue;
    if (!backgroundFacts.some((item) => claimTextMatches(item, text))) backgroundFacts.push(text);
    relocated.push(text);
  }

  for (const claim of claims.filter(shouldMoveWeakKeyClaim)) {
    const text = String(claim.text || '').trim();
    if (!text) continue;
    const removalText = String(
      claim.kind === 'key_claim' && isSummaryPlacement(claim)
        ? (claim.parentClaimText || text)
        : text,
    ).trim();
    if (!removeEverywhere(removalText, { includeBackground: claim.kind === 'premise_fact' })) continue;
    moved.push(text);
  }

  const nextDocument = {
    ...document,
    summary,
    backgroundFacts,
    keyFindings,
  };
  return {
    document: nextDocument,
    moved,
    relocated,
    changed: moved.length > 0 || relocated.length > 0,
  };
}

export function reviseUnsupportedKeyClaims(report, claims = [], options = {}) {
  const sourceDocument = options.document || parseMarkdownNarrative(report);
  const revision = reviseNarrativeDocument(sourceDocument, claims);
  let next = renderNarrativeMarkdown(revision.document);
  if (!revision.changed) {
    return {
      report: stripEmptyNarrativeSections(String(report || '')).trim() || next.trim(),
      document: revision.document,
      moved: revision.moved,
      relocated: revision.relocated,
      changed: false,
    };
  }
  next = stripEmptyNarrativeSections(ensureNarrativeAfterRevision(next));
  return {
    report: next.trim(),
    document: parseMarkdownNarrative(next),
    moved: revision.moved,
    relocated: revision.relocated,
    changed: true,
  };
}
