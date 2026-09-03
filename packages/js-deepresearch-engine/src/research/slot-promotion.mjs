import { isSuccessfulBody } from './body-quality.mjs';
import { tokenOverlapScore } from './passage-utils.mjs';
import { evaluateSourceRelevance, queryMatchesGapScope } from './adaptive/source-policy.mjs';

function sourceId(source) {
  return source?.id || source?.url || null;
}

function findingHasSource(finding, id) {
  return (finding.sources || []).some((source) => sourceId(source) === id);
}

export function shouldPromoteSourceToSlot(source, gap, {
  entities = [],
  entityAliases = [],
  targetDecision = null,
} = {}) {
  if (!gap || gap.rollup || ['verified', 'resolved'].includes(gap.status)) return null;
  const decision = evaluateSourceRelevance(source, {
    gap,
    query: gap.question || '',
    entities,
    entityAliases,
    rerankProvider: 'disabled',
    externalRerankEnabled: false,
    enforceEntity: true,
    allowRequiredHostProbe: false,
  });
  if (!decision.accepted) return null;
  const focus = [gap.question, gap.answerSlot, gap.claimFamily, ...(gap.evidenceCriteria || [])]
    .filter(Boolean)
    .join(' ');
  const text = String(source.content || source.summary || '').trim();
  if (!text) return null;
  const overlap = tokenOverlapScore(focus, text);
  const scoped = queryMatchesGapScope(text, gap, entities, [], entityAliases);
  const targetSemanticAdmission = targetDecision?.accepted === true
    && targetDecision.reasonCode === 'relevance_accepted'
    && Number.isFinite(targetDecision.rerankScore);
  if (overlap <= 0 && !scoped && !targetSemanticAdmission) return null;
  if ((gap.requiredSourceTypes || []).includes('primary_filing') && (gap.requiredHosts || []).length) {
    const hostOk = (gap.requiredHosts || []).some((host) => {
      try {
        const hostname = new URL(source.url || '').hostname.replace(/^www\./, '');
        return hostname === host || hostname.endsWith(`.${host}`);
      } catch {
        return false;
      }
    });
    if (!hostOk) return null;
  }
  return {
    decision: targetSemanticAdmission ? {
      ...decision,
      ...targetDecision,
      accepted: true,
      entityMatch: decision.entityMatch,
      matchedAlias: decision.matchedAlias,
    } : decision,
    overlap,
  };
}

export function promoteSuccessfulSources({
  state,
  sources = [],
  discoveryGapId = null,
  entities = [],
  entityAliases = [],
} = {}) {
  const unresolved = (state?.gaps || []).filter((gap) => (
    !gap.rollup
    && gap.requiredSlot
    && !['verified', 'resolved'].includes(gap.status)
  ));
  const created = [];
  for (const source of sources) {
    if (!isSuccessfulBody(source)) continue;
    const id = sourceId(source);
    if (!id) continue;
    for (const gap of unresolved) {
      if (gap.id === discoveryGapId) continue;
      const already = (state.findings || []).some((finding) => (
        finding.gapId === gap.id && findingHasSource(finding, id)
      ));
      if (already) continue;
      const candidate = state.candidates.get(id);
      const targetDecision = state.candidateDecisionForGap?.(candidate, gap.id)
        || candidate?.relevanceDecisionByGap?.[gap.id]
        || null;
      const promotion = shouldPromoteSourceToSlot(source, gap, {
        entities,
        entityAliases,
        targetDecision,
      });
      if (!promotion) continue;
      const finding = {
        question: gap.question,
        gapId: gap.id,
        contractSlotId: gap.contractSlotId,
        answerSlot: gap.answerSlot,
        sources: [{
          ...source,
          relevanceDecision: { ...promotion.decision, gapId: gap.id },
          promotedFromGapId: discoveryGapId,
        }],
        promoted: true,
        promotedFromGapId: discoveryGapId,
      };
      state.findings.push(finding);
      if (gap.status === 'blocked') {
        gap.status = 'body_read';
        gap.blockedReason = null;
      }
      if (candidate) {
        candidate.gapIds = [...new Set([...(candidate.gapIds || []), gap.id])];
        candidate.gapMatches = {
          ...(candidate.gapMatches || {}),
          [gap.id]: {
            ...(candidate.gapMatches?.[gap.id] || {}),
            relevanceDecision: { ...promotion.decision, gapId: gap.id },
            promoted: true,
          },
        };
        candidate.relevanceDecisionByGap = {
          ...(candidate.relevanceDecisionByGap || {}),
          [gap.id]: { ...promotion.decision, gapId: gap.id },
        };
      }
      created.push({
        sourceId: id,
        targetGapId: gap.id,
        discoveryGapId,
        overlap: promotion.overlap,
        decision: promotion.decision,
      });
    }
  }
  return created;
}
