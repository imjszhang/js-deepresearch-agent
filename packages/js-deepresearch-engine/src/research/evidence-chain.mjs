import crypto from 'node:crypto';
import { normalizeSourceUrl } from './source-candidates.mjs';
import { buildClaimEvaluation, extractQualityClaims } from './claim-quality.mjs';
import { buildCitationMap, parseCitations, resolveCitedSourceIds } from './citations.mjs';
import { sourceHasFetchedBody } from './focused-settings.mjs';
import {
  compareRankedPassages,
  isMediaOnlyPassage,
  rankingFocus,
  splitContentForPassages,
  tokenOverlapScore,
} from './passage-utils.mjs';
import { rankPassages } from './passage-selector.mjs';
import { pickSourceProvenance } from './source-provenance.mjs';

function hash(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function stableSourceId(source = {}) {
  const identity = normalizeSourceUrl(source.url) || `${source.title || ''}:${source.content || source.summary || source.snippet || ''}`;
  return hash('source', identity);
}

function mergeSourceRecord(existing, incoming) {
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  for (const field of [
    'title', 'url', 'snippet', 'engine', 'platform', 'publisher', 'author',
    'publishedAt', 'date', 'updatedAt', 'accessedAt', 'sourceType',
    'jurisdiction', 'productVersion', 'accessStatus', 'accessNotes',
  ]) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }
  if (String(incoming.summary || '').length > String(merged.summary || '').length) merged.summary = incoming.summary;
  if (String(incoming.content || '').length > String(merged.content || '').length) merged.content = incoming.content;
  if (incoming.fetchStatus === 'ok' || !merged.fetchStatus) merged.fetchStatus = incoming.fetchStatus || merged.fetchStatus;
  if (incoming.contentOrigin) merged.contentOrigin = incoming.contentOrigin;
  if (!merged.fetchError && incoming.fetchError) merged.fetchError = incoming.fetchError;
  return merged;
}

function rankSourceByOverlap(source, { query, finding, maxChars, maxPassages }) {
  const focus = rankingFocus({ query, question: finding.question, title: source.title });
  return splitContentForPassages(source.content, maxChars)
    .map((passage) => ({
      ...passage,
      retrievalScore: tokenOverlapScore(rankingFocus({ query: focus, section: passage.section }), passage.text),
      rankingMethod: 'overlap',
    }))
    .sort(compareRankedPassages)
    .slice(0, maxPassages);
}

function attachRankedPassages({
  passages,
  passageIds,
  sourceId,
  findingId,
  ranked = [],
  source = {},
}) {
  for (const passage of ranked) {
    const contentHash = crypto.createHash('sha256').update(passage.text).digest('hex');
    const idValue = hash('passage', `${sourceId}:${contentHash}`);
    if (!passages.some((item) => item.id === idValue)) {
      passages.push({
        id: idValue,
        sourceId,
        findingIds: [findingId],
        text: passage.text,
        startChar: passage.startChar,
        endChar: passage.endChar,
        section: passage.section || '',
        retrievalScore: passage.retrievalScore,
        rankingMethod: passage.rankingMethod || 'overlap',
        evidenceOrigin: 'source_content',
        observedAt: new Date().toISOString(),
        contentHash,
        assessment: source.assessment || null,
        provenance: pickSourceProvenance(source),
      });
    }
    passageIds.push(idValue);
  }
}

function finalizePassageArtifacts({ normalizedFindings, sourceMap, passages }) {
  return {
    findings: normalizedFindings,
    sources: [...sourceMap.values()],
    passages,
    citationMap: buildCitationMap(normalizedFindings, { sourceIdFor: stableSourceId }),
  };
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
      .map((passage) => ({ passage, score: tokenOverlapScore(claim.text, passage.text) }))
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

export const DEFAULT_MAX_PASSAGE_CHARS = 1200;

export function resolvePassageCharLimit(maxChars) {
  const value = Number(maxChars);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_PASSAGE_CHARS;
}

export function boundEvidenceText(text = '', maxChars = DEFAULT_MAX_PASSAGE_CHARS) {
  const value = String(text || '').trim();
  const limit = resolvePassageCharLimit(maxChars);
  if (value.length <= limit) return value;
  return value.slice(0, limit).trim();
}

export function selectDisplayedEvidence(source = {}, {
  passages = [],
  maxChars = DEFAULT_MAX_PASSAGE_CHARS,
} = {}) {
  const sourceId = source.id || stableSourceId(source);
  const top = [...passages]
    .filter((passage) => passage.sourceId === sourceId && !isMediaOnlyPassage(passage.text))
    .sort(compareRankedPassages)[0];
  if (top?.text) return boundEvidenceText(top.text, maxChars);
  const summary = String(source.summary || '').trim();
  if (summary) return boundEvidenceText(summary, maxChars);
  const snippet = String(source.snippet || '').trim();
  if (snippet) return boundEvidenceText(snippet, maxChars);
  const fallback = splitContentForPassages(source.content, maxChars).sort(compareRankedPassages)[0];
  return boundEvidenceText(fallback?.text || '', maxChars);
}

function collectNormalizedFindings({ findings, options }) {
  const passageEnabled = options.enabled !== false;
  const maxPassages = Number(options.maxPassagesPerSource) || 5;
  const maxChars = resolvePassageCharLimit(options.maxPassageChars);
  const sourceMap = new Map();
  const passages = [];
  const jobs = findings.map((finding, index) => {
    const id = finding.id || hash('finding', `${index}:${finding.question || ''}`);
    const sourceIds = [];
    const passageJobs = [];
    for (const source of finding.sources || []) {
      const sourceId = stableSourceId(source);
      source.id = sourceId;
      sourceIds.push(sourceId);
      sourceMap.set(sourceId, mergeSourceRecord(sourceMap.get(sourceId), source));
      const hasFetchedContent = sourceHasFetchedBody(source);
      if (!passageEnabled || !hasFetchedContent) continue;
      passageJobs.push({ source, sourceId, findingId: id });
    }
    return { finding, id, sourceIds, passageJobs };
  });
  return {
    options,
    maxPassages,
    maxChars,
    sourceMap,
    passages,
    jobs,
  };
}

function toNormalizedFinding(job, passageIds) {
  return {
    ...job.finding,
    id: job.id,
    gapId: job.finding.gapId || null,
    sourceIds: job.sourceIds,
    passageIds,
    evidenceStatus: passageIds.length ? 'direct_evidence' : ((job.finding.sources || []).length ? 'search_snippet' : 'missing'),
  };
}

export function buildPassageArtifacts({ query, findings = [], options = {} } = {}) {
  const state = collectNormalizedFindings({ findings, options });
  const normalizedFindings = state.jobs.map((job) => {
    const passageIds = [];
    for (const item of job.passageJobs) {
      const ranked = rankSourceByOverlap(item.source, {
        query,
        finding: job.finding,
        maxChars: state.maxChars,
        maxPassages: state.maxPassages,
      });
      attachRankedPassages({
        passages: state.passages,
        passageIds,
        sourceId: item.sourceId,
        findingId: job.id,
        ranked,
        source: item.source,
      });
    }
    return toNormalizedFinding(job, passageIds);
  });
  return finalizePassageArtifacts({
    normalizedFindings,
    sourceMap: state.sourceMap,
    passages: state.passages,
  });
}

export async function buildPassageArtifactsAsync({ query, findings = [], options = {} } = {}) {
  const state = collectNormalizedFindings({ findings, options });
  const normalizedFindings = [];
  for (const job of state.jobs) {
    const passageIds = [];
    for (const item of job.passageJobs) {
      const ranked = await rankPassages({
        query,
        question: job.finding.question,
        title: item.source.title,
        content: item.source.content,
        embedding: options.embedding,
        signal: options.signal,
        topK: state.maxPassages,
        chunkChars: state.maxChars,
      });
      attachRankedPassages({
        passages: state.passages,
        passageIds,
        sourceId: item.sourceId,
        findingId: job.id,
        ranked,
        source: item.source,
      });
    }
    normalizedFindings.push(toNormalizedFinding(job, passageIds));
  }
  return finalizePassageArtifacts({
    normalizedFindings,
    sourceMap: state.sourceMap,
    passages: state.passages,
  });
}

export function alignReportClaims({
  report = '',
  passages = [],
  citationMap,
  options = {},
} = {}) {
  return extractQualityClaims(report).map((claim, index) => {
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
  });
}

export function buildEvidenceArtifacts({ query, findings = [], report = '', options = {} }) {
  const passageArtifacts = buildPassageArtifacts({ query, findings, options });
  return {
    ...passageArtifacts,
    claims: options.claimAlignment
      ? alignReportClaims({
        report,
        passages: passageArtifacts.passages,
        citationMap: passageArtifacts.citationMap,
        options,
      })
      : [],
  };
}

export function extractClaims(report = '') {
  return extractQualityClaims(report);
}
