import crypto from 'node:crypto';
import { normalizeSourceUrl } from './source-candidates.mjs';
import { buildClaimEvaluation, extractQualityClaims } from './claim-quality.mjs';
import { buildCitationMap, parseCitations, resolveCitedSourceIds } from './citations.mjs';
import { sourceHasFetchedBody } from './focused-settings.mjs';

function hash(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function words(text = '') {
  const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const extra = [];
  for (const token of tokens) {
    if (!/\p{Script=Han}/u.test(token)) continue;
    for (let index = 0; index < token.length - 1; index += 1) {
      extra.push(token.slice(index, index + 2));
    }
  }
  return new Set([...tokens, ...extra]);
}

function overlap(left, right) {
  const a = words(left); const b = words(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.min(a.size, b.size);
}

export function stableSourceId(source = {}) {
  const identity = normalizeSourceUrl(source.url) || `${source.title || ''}:${source.content || source.summary || source.snippet || ''}`;
  return hash('source', identity);
}

function mergeSourceRecord(existing, incoming) {
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  for (const field of ['title', 'url', 'snippet', 'engine', 'platform', 'publishedAt', 'date', 'updatedAt']) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }
  if (String(incoming.summary || '').length > String(merged.summary || '').length) merged.summary = incoming.summary;
  if (String(incoming.content || '').length > String(merged.content || '').length) merged.content = incoming.content;
  if (incoming.fetchStatus === 'ok' || !merged.fetchStatus) merged.fetchStatus = incoming.fetchStatus || merged.fetchStatus;
  if (incoming.contentOrigin) merged.contentOrigin = incoming.contentOrigin;
  if (!merged.fetchError && incoming.fetchError) merged.fetchError = incoming.fetchError;
  return merged;
}

function splitContent(content, maxChars) {
  const chunks = [];
  let section = '';
  const paragraphs = String(content || '').split(/\n{2,}/);
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const text = paragraph.trim();
    const start = String(content).indexOf(paragraph, cursor);
    cursor = Math.max(cursor, start + paragraph.length);
    if (!text || /^(cookie|privacy|navigation|menu)\b/i.test(text)) continue;
    if (/^#{1,6}\s+/.test(text)) { section = text.replace(/^#{1,6}\s+/, ''); continue; }
    for (let offset = 0; offset < text.length; offset += maxChars) {
      const value = text.slice(offset, offset + maxChars).trim();
      if (value.length < 40) continue;
      chunks.push({ text: value, startChar: Math.max(0, start) + offset, endChar: Math.max(0, start) + offset + value.length, section });
    }
  }
  return chunks;
}

export function listSnippetOnlyCitationKeys(findings = []) {
  const keys = [];
  findings.forEach((finding, findingIndex) => {
    (finding.sources || []).forEach((source, sourceIndex) => {
      if (sourceHasFetchedBody(source)) return;
      keys.push(`${findingIndex + 1}.${sourceIndex + 1}`);
    });
  });
  return keys;
}

function requiresDirectEvidence(options = {}) {
  if (options.strictDirectEvidence !== undefined) return options.strictDirectEvidence === true;
  const strategy = options.strategy || 'focused';
  return strategy === 'focused' || strategy === 'exploratory';
}

export function alignClaimToCitedPassages(claim, {
  passages = [],
  citationMap,
  strategy,
  strictDirectEvidence,
} = {}) {
  const citationKeys = claim.citationKeys?.length ? claim.citationKeys : parseCitations(claim.text);
  const { citedSourceIds, unresolvedCitationKeys } = resolveCitedSourceIds(citationKeys, citationMap);
  const flags = [];
  const citedPassages = passages.filter((passage) => citedSourceIds.includes(passage.sourceId));
  const citedSourcesWithPassages = new Set(citedPassages.map((passage) => passage.sourceId));
  const missingBodySourceIds = citedSourceIds.filter((sourceId) => !citedSourcesWithPassages.has(sourceId));
  const keyFact = claim.kind === 'key_claim' || claim.importance === 'key';
  const enforceDirectEvidence = requiresDirectEvidence({ strategy, strictDirectEvidence });

  if (citationKeys.length === 0) flags.push('uncited');
  if (unresolvedCitationKeys.length > 0) flags.push('unresolved_citation');
  if (citationKeys.length > 0 && missingBodySourceIds.length > 0) flags.push('missing_direct_evidence');
  if (
    enforceDirectEvidence
    && keyFact
    && citedSourceIds.length > 0
    && citedPassages.length === 0
    && unresolvedCitationKeys.length === 0
  ) {
    flags.push('snippet_only');
  }

  const canUsePassages = citationKeys.length > 0
    && unresolvedCitationKeys.length === 0
    && citedPassages.length > 0;

  const candidates = canUsePassages
    ? citedPassages
      .map((passage) => ({ passage, score: overlap(claim.text, passage.text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    : [];

  const evidence = candidates
    .filter((item) => item.score > 0)
    .map(({ passage, score }) => ({
      sourceId: passage.sourceId,
      passageId: passage.id,
      verdict: score >= 0.45 ? 'supported' : (score >= 0.2 ? 'partially_supported' : 'unverifiable'),
      score,
      method: 'rules',
    }));

  const aligned = {
    ...claim,
    citationKeys,
    citedSourceIds,
    unresolvedCitationKeys,
    flags,
    evidenceConstraint: citationKeys.length ? 'cited_sources' : 'uncited',
    findingIds: [...new Set(evidence.flatMap((item) => passages.find((passage) => passage.id === item.passageId)?.findingIds || []))],
    evidence,
  };
  aligned.evaluation = buildClaimEvaluation(aligned);
  return aligned;
}

export function buildEvidenceArtifacts({ query, findings = [], report = '', options = {} }) {
  const passageEnabled = options.enabled !== false;
  const maxPassages = Number(options.maxPassagesPerSource) || 5;
  const maxChars = Number(options.maxPassageChars) || 1200;
  const sourceMap = new Map();
  const passages = [];
  const normalizedFindings = findings.map((finding, index) => {
    const id = finding.id || hash('finding', `${index}:${finding.question || ''}`);
    const sourceIds = [];
    const passageIds = [];
    for (const source of finding.sources || []) {
      const sourceId = stableSourceId(source);
      source.id = sourceId;
      sourceIds.push(sourceId);
      sourceMap.set(sourceId, mergeSourceRecord(sourceMap.get(sourceId), source));
      const hasFetchedContent = sourceHasFetchedBody(source);
      if (!passageEnabled || !hasFetchedContent) continue;
      const ranked = splitContent(source.content, maxChars)
        .map((passage) => ({ ...passage, retrievalScore: overlap(`${query} ${finding.question}`, passage.text) }))
        .sort((a, b) => b.retrievalScore - a.retrievalScore)
        .slice(0, maxPassages);
      for (const passage of ranked) {
        const contentHash = crypto.createHash('sha256').update(passage.text).digest('hex');
        const idValue = hash('passage', `${sourceId}:${contentHash}`);
        if (!passages.some((item) => item.id === idValue)) passages.push({ id: idValue, sourceId, findingIds: [id], ...passage, evidenceOrigin: 'source_content', observedAt: new Date().toISOString(), contentHash });
        passageIds.push(idValue);
      }
    }
    return { ...finding, id, gapId: finding.gapId || null, sourceIds, passageIds, evidenceStatus: passageIds.length ? 'direct_evidence' : ((finding.sources || []).length ? 'search_snippet' : 'missing') };
  });

  const citationMap = buildCitationMap(normalizedFindings, { sourceIdFor: stableSourceId });
  const claims = options.claimAlignment ? extractQualityClaims(report).map((claim, index) => {
    const aligned = alignClaimToCitedPassages(claim, {
      passages,
      citationMap,
      strategy: options.strategy,
      strictDirectEvidence: options.strictDirectEvidence,
    });
    return {
      id: hash('claim', `${index}:${aligned.text}`),
      ...aligned,
      ...(aligned.parentClaimText ? { parentClaimId: hash('claim-parent', aligned.parentClaimText) } : {}),
    };
  }) : [];

  return { findings: normalizedFindings, sources: [...sourceMap.values()], passages, claims, citationMap };
}

export function extractClaims(report = '') {
  return extractQualityClaims(report);
}
