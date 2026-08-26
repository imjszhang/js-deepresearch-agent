import { parseCitations } from './citations.mjs';

export const QUALITY_METRICS_VERSION = 3;
export const CLAIM_EXTRACTION_VERSION = 4;
export const CLAIM_EVALUATION_VERSION = 4;

export const FACT_CLAIM_KINDS = new Set(['key_claim']);
export const CLAIM_VERDICTS = Object.freeze([
  'supported',
  'partially_supported',
  'unsupported',
  'unverifiable',
  'conflicting',
]);

const SECTION_ALIASES = Object.freeze({
  key_claim: [
    'summary', 'executive summary', 'key findings', 'findings', 'conclusion',
    '摘要', '总结', '概述', '关键发现', '核心发现', '主要发现', '核心结论', '结论',
  ],
  evidence_entry: ['evidence', 'analysis', 'details', '证据', '分析', '详细信息'],
  caveat: ['caveats', 'limitations', 'risks', '局限', '限制', '风险', '注意事项'],
  recommendation: ['recommendations', 'recommendation', 'next steps', '建议', '后续步骤'],
  source_entry: [
    'sources', 'source list', 'references', 'bibliography',
    '主要来源', '参考文献', '引用来源', '来源',
  ],
  metadata: ['contents', 'table of contents', '目录', 'metadata', '元数据'],
});

const ABBREVIATION_PATTERN = /\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|prof|sr|jr|inc|ltd|vs|u\.s|u\.k|a\.m|p\.m|fig|eq|al|no|vol|pp)\./gi;

function normalizeHeading(value = '') {
  return String(value).normalize('NFKC').trim().toLowerCase()
    .replace(/^\d+(?:\.\d+)*[.)]?\s*/, '')
    .replace(/[：:]$/, '')
    .trim();
}

function matchesAlias(heading, aliases) {
  const normalized = normalizeHeading(heading);
  return aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias}:`) || normalized.startsWith(`${alias}：`));
}

export function explicitClaimSectionKind(section = '') {
  for (const [kind, aliases] of Object.entries(SECTION_ALIASES)) {
    if (matchesAlias(section, aliases)) return kind;
  }
  return null;
}

export function classifyClaimSection(section = '') {
  return explicitClaimSectionKind(section) || 'supporting_claim';
}

export function resolveClaimKindFromHeadingStack(heading, {
  level = 2,
  currentKind = 'supporting_claim',
} = {}) {
  const explicit = explicitClaimSectionKind(heading);
  if (Number(level) === 1 && !explicit) return currentKind;
  if (explicit) return explicit;
  return currentKind;
}

function stripMarkdownDecorators(text = '') {
  return String(text)
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function normalizedClaimKey(text = '') {
  return stripMarkdownDecorators(text)
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？]+$/, '')
    .toLowerCase();
}

function isSourceEntryText(text = '') {
  const value = stripMarkdownDecorators(text);
  return /^https?:\/\/\S+$/i.test(value)
    || /^\[?\d+\.\d+\]?\s+.*https?:\/\/\S+/i.test(value)
    || /^\[[^\]]+\]\(https?:\/\//i.test(value);
}

function withProtectedSpans(text, fn) {
  const spans = [];
  let value = String(text);
  const protect = (pattern) => {
    value = value.replace(pattern, (match) => {
      const token = `\uE000${spans.length}\uE001`;
      spans.push(match);
      return token;
    });
  };
  protect(/https?:\/\/[^\s\]]+/gi);
  protect(/\[[0-9]+(?:\.[0-9]+)?(?:\s*[-,，]\s*[0-9]+(?:\.[0-9]+)?)*\]/g);
  protect(/\b[vV]?\d+\.\d+(?:\.\d+)+\b/g);
  protect(/\b\d+\.\d+(?:\s*(?:tokens\/sec|tok\/s|ms|s|kb|mb|gb|%))?\b/gi);
  protect(ABBREVIATION_PATTERN);
  const restore = (part) => String(part).replace(/\uE000(\d+)\uE001/g, (_, index) => spans[Number(index)]);
  const result = fn(value);
  return Array.isArray(result) ? result.map((part) => restore(part).trim()).filter(Boolean) : restore(result);
}

function splitOnDelimiters(text, pattern) {
  return withProtectedSpans(text, (value) => value.split(pattern).map((item) => item.trim()).filter(Boolean));
}

function splitSentences(text = '') {
  return splitOnDelimiters(text, /(?<=[。！？])\s*|(?<=[.?!])(?=\s+)/);
}

function splitOnSemicolons(text = '') {
  const pieces = splitOnDelimiters(text, /[;；]\s*/);
  if (pieces.length < 2 || pieces.some((item) => item.length < 30)) return [String(text).trim()].filter(Boolean);
  return pieces;
}

function splitIndependentClauses(text = '') {
  if (String(text).length < 80) return [String(text).trim()].filter(Boolean);
  const pieces = splitOnDelimiters(text, /,\s+(?:and|but|while)\s+|，(?:且|并|同时)/);
  if (pieces.length < 2 || pieces.some((item) => item.length < 40)) return [String(text).trim()].filter(Boolean);
  return pieces;
}

const CITATION_ONLY_PATTERN = /^(?:\[[0-9]+(?:\.[0-9]+)?(?:\s*[-,，]\s*[0-9]+(?:\.[0-9]+)?)*\]\s*)+$/;

function mergeTrailingCitationAtoms(atoms = []) {
  const merged = [];
  for (const atom of atoms) {
    if (CITATION_ONLY_PATTERN.test(atom.text) && merged.length) {
      const previous = merged[merged.length - 1];
      previous.text = `${previous.text} ${atom.text}`.trim();
      previous.citationKeys = [...new Set([...(previous.citationKeys || []), ...(atom.citationKeys || [])])];
      continue;
    }
    merged.push({ ...atom, citationKeys: [...(atom.citationKeys || [])] });
  }
  return merged;
}

export function splitAtomicClaimTexts(text = '') {
  const cleaned = String(text).trim();
  if (!cleaned) return [];
  const parentCitations = parseCitations(cleaned);
  const atoms = [];
  for (const sentence of splitSentences(cleaned)) {
    for (const chunk of splitOnSemicolons(sentence)) {
      const inherited = parseCitations(chunk);
      for (const clause of splitIndependentClauses(chunk)) {
        const own = parseCitations(clause);
        atoms.push({
          text: clause,
          citationKeys: own.length ? own : (parentCitations.length ? parentCitations : inherited),
        });
      }
    }
  }
  const merged = mergeTrailingCitationAtoms(atoms);
  return merged.length ? merged : [{ text: cleaned, citationKeys: parentCitations }];
}

function isSkippableLine(line = '') {
  const value = line.trim();
  return !value
    || value.startsWith('```')
    || value.startsWith('|')
    || /^-{3,}$/.test(value)
    || /^---$/.test(value);
}

/**
 * Deterministically extracts atomic, classified report statements.
 * Source entries and metadata are omitted. Compound Summary / Findings /
 * Evidence lines are split into independently verifiable atoms.
 * Unknown subheadings inherit the nearest explicit section kind.
 */
export function extractQualityClaims(report = '') {
  const lines = String(report).split(/\r?\n/);
  const claims = [];
  const seen = new Set();
  let section = 'Introduction';
  let kind = 'supporting_claim';

  function push(text, lineStart) {
    const cleaned = stripMarkdownDecorators(text);
    if (cleaned.length < 8 || isSourceEntryText(cleaned)) return;
    const atoms = splitAtomicClaimTexts(cleaned);
    for (const atom of atoms) {
      const key = normalizedClaimKey(atom.text);
      if (!key || atom.text.length < 8 || seen.has(key)) continue;
      seen.add(key);
      claims.push({
        section,
        text: atom.text,
        lineStart,
        kind,
        importance: kind === 'key_claim' ? 'key' : 'supporting',
        citationKeys: atom.citationKeys,
        ...(atom.text !== cleaned ? { parentClaimText: cleaned } : {}),
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      section = heading[2].trim();
      kind = resolveClaimKindFromHeadingStack(section, {
        level: heading[1].length,
        currentKind: kind,
      });
      continue;
    }
    if (kind === 'source_entry' || kind === 'metadata' || isSkippableLine(line)) continue;
    push(line, index + 1);
  }
  return claims;
}

function verdictCounts(evidence = []) {
  const counts = {
    supported: 0,
    partiallySupported: 0,
    unsupported: 0,
    unverifiable: 0,
  };
  for (const item of evidence || []) {
    if (item?.verdict === 'supported') counts.supported += 1;
    else if (item?.verdict === 'partially_supported') counts.partiallySupported += 1;
    else if (item?.verdict === 'unsupported') counts.unsupported += 1;
    else counts.unverifiable += 1;
  }
  return counts;
}

export function aggregateEvidenceVerdict(evidence = []) {
  const counts = verdictCounts(evidence);
  let verdict = 'unverifiable';
  if (counts.unsupported > 0 && (counts.supported > 0 || counts.partiallySupported > 0)) verdict = 'conflicting';
  else if (counts.unsupported > 0) verdict = 'unsupported';
  else if (counts.supported > 0) verdict = 'supported';
  else if (counts.partiallySupported > 0) verdict = 'partially_supported';

  const relevantScores = (evidence || [])
    .filter((item) => item?.verdict === verdict || (verdict === 'conflicting' && item?.verdict !== 'unverifiable'))
    .map((item) => Number(item?.score))
    .filter(Number.isFinite);

  return {
    verdict,
    confidence: relevantScores.length
      ? Number((relevantScores.reduce((sum, score) => sum + score, 0) / relevantScores.length).toFixed(4))
      : 0,
    evidenceCounts: counts,
  };
}

function constrainVerdict(verdict, flags = []) {
  if (flags.includes('uncited') || flags.includes('unresolved_citation')) return 'unverifiable';
  if (flags.includes('missing_direct_evidence') && ['supported', 'partially_supported'].includes(verdict)) {
    return 'unverifiable';
  }
  return verdict;
}

export function buildClaimEvaluation(claim, {
  method = 'rules',
  origin = 'runtime_rule',
  evaluatedAt = new Date().toISOString(),
} = {}) {
  const flags = [...new Set([...(claim?.flags || [])])];
  const hasCitedBodySupport = (claim?.evidence || []).some((item) => (
    item?.passageId
    && ['supported', 'partially_supported'].includes(item.verdict)
    && (!claim.citedSourceIds?.length || claim.citedSourceIds.includes(item.sourceId))
  ));
  const aggregated = aggregateEvidenceVerdict(claim?.evidence || []);
  const blockedByMissingBody = flags.includes('missing_direct_evidence') && !hasCitedBodySupport;
  const verdict = constrainVerdict(
    aggregated.verdict,
    blockedByMissingBody ? flags : flags.filter((flag) => flag !== 'missing_direct_evidence'),
  );
  return {
    ...aggregated,
    verdict,
    confidence: verdict === aggregated.verdict ? aggregated.confidence : 0,
    method,
    origin,
    evaluatedAt,
    evaluationVersion: CLAIM_EVALUATION_VERSION,
    flags,
  };
}

export function normalizeClaim(claim = {}, options = {}) {
  const kind = claim.kind
    || (claim.importance === 'key' ? 'key_claim' : classifyClaimSection(claim.section));
  const evaluation = claim.evaluation && options.recalculateEvaluation !== true
    ? claim.evaluation
    : buildClaimEvaluation(claim, options);
  return {
    ...claim,
    kind,
    importance: kind === 'key_claim' ? 'key' : (claim.importance || 'supporting'),
    evaluation,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

export function isCompoundParentClaim(claim = {}, claims = []) {
  if (claim.role === 'parent' || claim.excludeFromRates === true) return true;
  const key = normalizedClaimKey(claim.text);
  if (!key) return false;
  return claims.some((other) => other !== claim && other.parentClaimText && normalizedClaimKey(other.parentClaimText) === key);
}

export function selectCountableClaims(claims = []) {
  return claims.filter((claim) => !isCompoundParentClaim(claim, claims));
}

export function calculateQualityMetrics(claims = []) {
  const normalized = claims.map((claim) => normalizeClaim(claim));
  const countable = selectCountableClaims(normalized);
  const facts = countable.filter((claim) => FACT_CLAIM_KINDS.has(claim.kind));
  const keyClaims = facts.filter((claim) => claim.kind === 'key_claim');
  const supportingClaims = countable.filter((claim) => claim.kind === 'supporting_claim');
  const verdicts = Object.fromEntries(CLAIM_VERDICTS.map((verdict) => [verdict, 0]));
  for (const claim of facts) verdicts[claim.evaluation.verdict] += 1;

  const withEvidence = facts.filter((claim) => (claim.evidence || []).length > 0).length;
  const withDirectEvidence = facts.filter((claim) => (claim.evidence || []).some((item) => item.passageId)).length;
  const supportedKeys = keyClaims.filter((claim) => claim.evaluation.verdict === 'supported').length;

  return {
    metricsVersion: QUALITY_METRICS_VERSION,
    claimExtractionVersion: CLAIM_EXTRACTION_VERSION,
    claimEvaluationVersion: CLAIM_EVALUATION_VERSION,
    claimCount: countable.length,
    evaluatedClaimCount: facts.length,
    keyClaimCount: keyClaims.length,
    supportingClaimCount: supportingClaims.length,
    evidenceEntryCount: countable.filter((claim) => claim.kind === 'evidence_entry').length,
    caveatCount: countable.filter((claim) => claim.kind === 'caveat').length,
    recommendationCount: countable.filter((claim) => claim.kind === 'recommendation').length,
    claims: {
      supported: verdicts.supported,
      partiallySupported: verdicts.partially_supported,
      unsupported: verdicts.unsupported,
      unverifiable: verdicts.unverifiable,
      conflicting: verdicts.conflicting,
    },
    rates: {
      evidenceCoverageRate: rate(withEvidence, facts.length),
      directEvidenceRate: rate(withDirectEvidence, facts.length),
      supportedRate: rate(verdicts.supported, facts.length),
      supportedOrPartialRate: rate(verdicts.supported + verdicts.partially_supported, facts.length),
      partiallySupportedRate: rate(verdicts.partially_supported, facts.length),
      unsupportedRate: rate(verdicts.unsupported, facts.length),
      unverifiableRate: rate(verdicts.unverifiable, facts.length),
      conflictingRate: rate(verdicts.conflicting, facts.length),
      keyClaimSupportedRate: rate(supportedKeys, keyClaims.length),
    },
  };
}

export function qualityGateFromClaims(claims = []) {
  const normalized = selectCountableClaims(claims.map((claim) => normalizeClaim(claim)));
  const keyClaims = normalized.filter((claim) => claim.kind === 'key_claim');
  if (normalized.length === 0) return 'fail';
  if (keyClaims.length === 0) return 'pass_with_warnings';
  if (keyClaims.some((claim) => ['unsupported', 'conflicting'].includes(claim.evaluation.verdict))) return 'fail';
  if (keyClaims.some((claim) => ['partially_supported', 'unverifiable'].includes(claim.evaluation.verdict))) return 'pass_with_warnings';
  return 'pass';
}
