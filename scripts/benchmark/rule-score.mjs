import { parseCitations, resolveCitations } from './citations.mjs';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  '的', '了', '在', '是', '和', '与', '及', '等', '也', '都', '而', '被', '对',
]);

function tokenize(text = '') {
  const tokens = new Set();
  const normalized = String(text).toLowerCase();

  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/g)) {
    const token = match[0];
    if (!STOP_WORDS.has(token)) {
      tokens.add(token);
    }
  }

  return tokens;
}

export function keywordOverlap(claimText = '', sources = []) {
  const claimTokens = tokenize(claimText);
  if (claimTokens.size === 0) return 0;

  const sourceTokens = new Set();
  for (const entry of sources) {
    const source = entry.source || entry;
    const evidence = source.summary || source.content || source.snippet || '';
    for (const token of tokenize(`${source.title || ''} ${evidence}`)) {
      sourceTokens.add(token);
    }
  }

  if (sourceTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of claimTokens) {
    if (sourceTokens.has(token)) overlap += 1;
  }

  return overlap / claimTokens.size;
}

export function sourceIsComplete(source = {}) {
  const evidence = source.summary || source.content || source.snippet || '';
  return Boolean(String(source.title || '').trim())
    && Boolean(String(source.url || '').trim())
    && Boolean(String(evidence).trim());
}

export function scoreClaimRule(claim, citationMap, options = {}) {
  const citationKeys = parseCitations(claim.text);
  const { resolved, unresolved } = resolveCitations(citationKeys, citationMap);
  const sources = resolved.map((entry) => entry.source);
  const overlap = keywordOverlap(claim.text, resolved);
  const strictPlatform = options.strictPlatform || null;

  const flags = [];
  if (citationKeys.length === 0) flags.push('no_citation');
  if (unresolved.length > 0) flags.push('citation_unresolved');
  if (resolved.length > 0 && !sources.every(sourceIsComplete)) {
    flags.push('missing_source_fields');
  }
  if (strictPlatform && resolved.length > 0) {
    const platformMatches = sources.every((source) => source.engine === strictPlatform);
    if (!platformMatches) flags.push('platform_mismatch');
  }
  if (citationKeys.length > 0 && overlap < 0.08) flags.push('low_keyword_overlap');

  return {
    claim,
    citationKeys,
    unresolvedCitations: unresolved,
    resolvedSources: resolved,
    hasCitations: citationKeys.length > 0,
    citationsResolved: unresolved.length === 0,
    sourcesComplete: resolved.length === 0 || sources.every(sourceIsComplete),
    platformMatch: !strictPlatform || resolved.length === 0
      || sources.every((source) => source.engine === strictPlatform),
    keywordOverlap: overlap,
    flags,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

export function summarizeFindingsHealth(findings = [], sources = []) {
  const findingErrors = findings.filter((finding) => finding?.error).length;
  const findingsWithSources = findings.filter(
    (finding) => Array.isArray(finding?.sources) && finding.sources.length > 0,
  ).length;

  const withEvidence = sources.filter((source) => source.summary || source.content || source.snippet).length;
  const withContent = sources.filter((source) => source.content).length;
  const enrichOk = sources.filter((source) => source.fetchStatus === 'ok').length;
  const enrichFailed = sources.filter((source) => source.fetchStatus === 'failed').length;
  const enrichAttempted = sources.filter((source) => source.fetchStatus).length;

  const flags = [];
  if (sources.length === 0) flags.push('empty_sources');
  if (findingErrors === findings.length && findings.length > 0) flags.push('all_findings_failed');
  if (findingsWithSources === 0 && findings.length > 0) flags.push('no_finding_sources');
  if (enrichAttempted > 0 && enrichOk === 0) flags.push('enrichment_all_failed');

  return {
    findingCount: findings.length,
    findingErrors,
    findingsWithSources,
    sourceCount: sources.length,
    enrichment: {
      withEvidence,
      withContent,
      enrichOk,
      enrichFailed,
      enrichAttempted,
      evidenceRate: rate(withEvidence, sources.length),
      contentRate: rate(withContent, sources.length),
      enrichOkRate: rate(enrichOk, enrichAttempted),
    },
    flags,
  };
}
