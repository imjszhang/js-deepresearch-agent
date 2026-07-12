export const QUALITY_METRICS_VERSION = 2;
export const CLAIM_EXTRACTION_VERSION = 2;
export const CLAIM_EVALUATION_VERSION = 2;

export const FACT_CLAIM_KINDS = new Set(['key_claim', 'supporting_claim']);
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
  supporting_claim: ['evidence', 'analysis', 'details', '证据', '分析', '详细信息'],
  caveat: ['caveats', 'limitations', 'risks', '局限', '限制', '风险', '注意事项'],
  recommendation: ['recommendations', 'recommendation', 'next steps', '建议', '后续步骤'],
  source_entry: [
    'sources', 'source list', 'references', 'bibliography',
    '主要来源', '参考文献', '引用来源', '来源',
  ],
  metadata: ['contents', 'table of contents', '目录', 'metadata', '元数据'],
});

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

export function classifyClaimSection(section = '') {
  for (const [kind, aliases] of Object.entries(SECTION_ALIASES)) {
    if (matchesAlias(section, aliases)) return kind;
  }
  return 'supporting_claim';
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

function splitCompoundClaim(text = '') {
  const pieces = String(text).split(/[;；]\s*/).map((item) => item.trim()).filter(Boolean);
  if (pieces.length < 2 || pieces.some((item) => item.length < 30)) return [String(text).trim()];
  return pieces;
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
 * Deterministically extracts and classifies reusable report statements.
 * Source entries and metadata are deliberately omitted from the returned list.
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
    for (const piece of splitCompoundClaim(cleaned)) {
      const key = normalizedClaimKey(piece);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      claims.push({
        section,
        text: piece,
        lineStart,
        kind,
        importance: kind === 'key_claim' ? 'key' : 'supporting',
        ...(piece !== cleaned ? { parentClaimText: cleaned } : {}),
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      kind = classifyClaimSection(section);
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

export function buildClaimEvaluation(claim, {
  method = 'rules',
  origin = 'runtime_rule',
  evaluatedAt = new Date().toISOString(),
} = {}) {
  const aggregated = aggregateEvidenceVerdict(claim?.evidence || []);
  return {
    ...aggregated,
    method,
    origin,
    evaluatedAt,
    evaluationVersion: CLAIM_EVALUATION_VERSION,
  };
}

export function normalizeClaim(claim = {}, options = {}) {
  const kind = claim.kind
    || (claim.importance === 'key' ? 'key_claim' : classifyClaimSection(claim.section));
  const evaluation = claim.evaluation?.evaluationVersion === CLAIM_EVALUATION_VERSION
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

export function calculateQualityMetrics(claims = []) {
  const normalized = claims.map((claim) => normalizeClaim(claim));
  const facts = normalized.filter((claim) => FACT_CLAIM_KINDS.has(claim.kind));
  const keyClaims = facts.filter((claim) => claim.kind === 'key_claim');
  const supportingClaims = facts.filter((claim) => claim.kind === 'supporting_claim');
  const verdicts = Object.fromEntries(CLAIM_VERDICTS.map((verdict) => [verdict, 0]));
  for (const claim of facts) verdicts[claim.evaluation.verdict] += 1;

  const withEvidence = facts.filter((claim) => (claim.evidence || []).length > 0).length;
  const withDirectEvidence = facts.filter((claim) => (claim.evidence || []).some((item) => item.passageId)).length;
  const supportedKeys = keyClaims.filter((claim) => claim.evaluation.verdict === 'supported').length;

  return {
    metricsVersion: QUALITY_METRICS_VERSION,
    claimExtractionVersion: CLAIM_EXTRACTION_VERSION,
    claimEvaluationVersion: CLAIM_EVALUATION_VERSION,
    claimCount: normalized.length,
    evaluatedClaimCount: facts.length,
    keyClaimCount: keyClaims.length,
    supportingClaimCount: supportingClaims.length,
    caveatCount: normalized.filter((claim) => claim.kind === 'caveat').length,
    recommendationCount: normalized.filter((claim) => claim.kind === 'recommendation').length,
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
      partiallySupportedRate: rate(verdicts.partially_supported, facts.length),
      unsupportedRate: rate(verdicts.unsupported, facts.length),
      unverifiableRate: rate(verdicts.unverifiable, facts.length),
      conflictingRate: rate(verdicts.conflicting, facts.length),
      keyClaimSupportedRate: rate(supportedKeys, keyClaims.length),
    },
  };
}

export function qualityGateFromClaims(claims = []) {
  const normalized = claims.map((claim) => normalizeClaim(claim));
  const keyClaims = normalized.filter((claim) => claim.kind === 'key_claim');
  if (keyClaims.length === 0) return 'pass_with_warnings';
  if (keyClaims.some((claim) => ['unsupported', 'conflicting'].includes(claim.evaluation.verdict))) return 'fail';
  if (keyClaims.some((claim) => ['partially_supported', 'unverifiable'].includes(claim.evaluation.verdict))) return 'pass_with_warnings';
  return 'pass';
}
