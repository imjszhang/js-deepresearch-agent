import { enrichFindings } from '../source-enricher.mjs';
import { applySlotSupportJudgments, judgeOpenSlotSupport } from '../gap-slot-support.mjs';
import { evidenceStatusOf } from '../gap-state.mjs';
import {
  classifyFetchedBody,
  isRetryableReadFailure,
  isTransportReadFailure,
  isTransportReadSkip,
  MAX_RETRYABLE_READ_ATTEMPTS,
  sanitizeUnusableSourceBody,
  transportFailureReason,
} from '../body-quality.mjs';
import { evaluateSourceRelevance, classifySourceTier } from '../adaptive/source-policy.mjs';
import { promoteSuccessfulSources } from '../slot-promotion.mjs';
import { readAddsNovelty } from '../adaptive/embedding-signals.mjs';
import { addTrace, selectedFinding } from './exploratory-planning.mjs';

export function createReadExecutor({ state, loopLocal, query, llm, signal, emit, settings, budget, embedding, recorder, readPolicy, maxReads, trace }) {
  return async function performRead({ sourceIds, gapId, reasonCode, harvest = false }) {
    const tokensBefore = budget?.usage?.llmTokens || 0;
    emit({
      stage: 'enriching_sources',
      step: Math.max(1, state.step),
      maxSteps: state.maxSteps,
      total: sourceIds.length,
    });
    const targetGap = state.getGap(gapId);
    let finding = selectedFinding(state, sourceIds, gapId);
    finding = (await enrichFindings([finding], {
      query,
      fetchMode: readPolicy.fetchMode,
      maxUrlsPerIteration: maxReads,
      maxUrlsTotal: maxReads,
      maxContentChars: readPolicy.maxContentChars,
      maxFetchChars: readPolicy.maxFetchChars,
      enrichConcurrency: readPolicy.enrichConcurrency,
      llm,
      signal,
      settings,
      budget,
      embedding,
      relevance: readPolicy.relevance,
      relevanceGap: targetGap,
      entities: state.brief?.entities || state.profile?.brief?.entities || [],
      entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
      observedHosts: [...(state.observedHosts || [])],
      recorder,
      transportMemory: state.transportMemory,
    }))[0];
    state.evidenceStore?.captureFindings([finding]);
    const classifiedSources = [];
    let successful = 0;
    let transportFailures = 0;
    let transportSkips = 0;
    let attempted = 0;
    for (const source of finding.sources || []) {
      const id = source.id || source.url;
      let quality = classifyFetchedBody(source);
      const candidate = state.candidates.get(id) || {};
      const gapDecision = candidate.gapMatches?.[targetGap?.id]?.relevanceDecision
        || candidate.relevanceDecisionByGap?.[targetGap?.id]
        || source.relevanceDecision
        || null;
      let bodyRelevance = gapDecision ? { ...gapDecision, gapId: targetGap?.id || finding.gapId } : null;
      if (quality.successful && readPolicy.relevance.bodyValidation) {
        bodyRelevance = {
          ...evaluateSourceRelevance(source, {
          ...readPolicy.relevance,
          gap: targetGap,
          query: targetGap?.question || query,
          entities: state.brief?.entities || state.profile?.brief?.entities || [],
          entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
          enforceEntity: readPolicy.relevance.entityGuard !== false,
          rerankProvider: 'disabled',
          allowRequiredHostProbe: false,
          }),
          gapId: targetGap?.id || finding.gapId,
        };
        if (!bodyRelevance.accepted) {
          quality = {
            status: 'irrelevant',
            successful: false,
            reason: bodyRelevance.reasonCode,
          };
        }
      }
      const next = sanitizeUnusableSourceBody({
        ...source,
        id,
        bodyQuality: quality.status,
        bodyQualityReason: quality.reason,
        tier: classifySourceTier(source, targetGap),
        assessment: source.assessment || null,
        relevanceDecision: bodyRelevance,
        relevanceDecisionByGap: {
          ...(source.relevanceDecisionByGap || candidate.relevanceDecisionByGap || {}),
          [targetGap?.id || finding.gapId]: bodyRelevance,
        },
      }, quality);
      classifiedSources.push(next);
      const existing = state.candidates.get(id) || {};
      const existingMatch = existing.gapMatches?.[targetGap?.id] || {};
      const readAttempts = Number(existing.readAttempts || 0) + 1;
      // TransportMemory owns retry boundaries. The fetcher has already
      // consumed allowed transient retries, so re-queuing this candidate
      // would only produce a memory skip for the same backend/path.
      const retryable = isRetryableReadFailure(quality)
        && !source.backend
        && !source.transportMemorySkipped;
      const consumeRead = !retryable || readAttempts >= MAX_RETRYABLE_READ_ATTEMPTS;
      state.candidates.set(id, {
        ...existing,
        ...next,
        id,
        freq: existing.freq || 1,
        readAttempts,
        status: consumeRead ? (next.status || existing.status) : 'unread',
      });
      const stored = state.candidates.get(id);
      stored.gapMatches = {
        ...(stored.gapMatches || {}),
        [targetGap?.id || finding.gapId]: {
          ...existingMatch,
          relevanceDecision: bodyRelevance,
        },
      };
      if (consumeRead) {
        state.readSourceIds.add(id);
        state.markCandidateStatus(id, quality.status, quality.reason);
      } else {
        stored.status = 'unread';
        stored.skipReason = quality.reason;
      }
      attempted += 1;
      if (source.assessmentStatus === 'unavailable') {
        state.relevance.assessmentUnavailable += 1;
        if (quality.successful) state.relevance.admittedWithoutAssessment += 1;
      }
      if (isTransportReadSkip(source)) {
        transportSkips += 1;
        state.recordTransportSkip(source.fetchErrorType);
      } else if (isTransportReadFailure(source, quality)) {
        transportFailures += 1;
        state.recordTransportFailure({
          hostname: source.hostname,
          url: source.url || id,
          reason: transportFailureReason(source, quality),
        });
      }
      if (quality.successful) {
        successful += 1;
        state.clearTransportStreak();
        state.relevance.readAccepted += 1;
        state.noteSuccessfulBody();
        state.addKnowledge({ gapId: finding.gapId, sourceId: id, learned: next.summary || next.content || next.snippet });
        const known = state.knowledge
          .filter((item) => item.gapId === finding.gapId && item.sourceId)
          .map((item) => item.learned);
        const novelty = await readAddsNovelty({
          embedding,
          newText: next.summary || next.content || '',
          knownTexts: known.slice(0, -1),
          signal,
          traces: state.embeddingTraces,
        });
        next.novelty = novelty.novel;
        state.noteReadNovelty(novelty.novel);
      } else if (quality.status === 'irrelevant') {
        state.relevance.bodyIrrelevant += 1;
      }
      const gap = state.getGap(finding.gapId);
      if (consumeRead && gap && !gap.readSourceIds.includes(id)) gap.readSourceIds.push(id);
    }
    finding.sources = classifiedSources;
    state.findings.push(finding);
    const promotions = promoteSuccessfulSources({
      state,
      sources: classifiedSources,
      discoveryGapId: finding.gapId,
      entities: state.brief?.entities || state.profile?.brief?.entities || [],
      entityAliases: state.brief?.entityAliases || state.profile?.brief?.entityAliases || [],
    });
    if (promotions.length) {
      state.noteProgressKind('progress');
      for (const item of promotions) state.clearPlannerFailure({ gapId: item.targetGapId });
      addTrace(trace, state, 'slot_promotion', {
        reasonCode: 'cross_slot_promotion',
        promotions,
        targetGapIds: promotions.map((item) => item.targetGapId),
      }, budget);
    }
    const readHostnames = classifiedSources.map((source) => source.hostname).filter(Boolean);
    state.observations.push({
      type: 'read_result',
      sourceIds,
      successful,
      harvest,
      waf: classifiedSources.filter((source) => source.bodyQuality === 'waf').length,
    });
    state.addDiary(`${harvest ? 'auto-harvested' : 'read'} ${sourceIds.length} source(s) (${readHostnames.join(', ') || 'unknown hosts'}) for ${finding.gapId}; ${successful} successful bodies`);
    state.actionCosts.record('read', (budget?.usage?.llmTokens || 0) - tokensBefore);
    state.syncGapCoverage();
    if (successful > 0) {
      const support = await judgeOpenSlotSupport({
        llm,
        signal,
        query,
        gaps: state.gaps,
        findings: state.findings,
        brief: state.brief,
        profile: state.profile,
        cache: state.slotSupportCache,
        evidenceStore: state.evidenceStore,
      });
      applySlotSupportJudgments(state.gaps, support.judgments);
      state.syncGapCoverage();
      if (support.judgments.some((item) => ['supported', 'partially_supported'].includes(item.verdict))) {
        loopLocal.consecutiveInvalidSteps = 0;
        state.noteProgressKind('progress');
      }
      if ((support.selections || []).some((item) => item.evidenceTypes?.length)) {
        loopLocal.consecutiveInvalidSteps = 0;
        state.noteProgressKind('progress');
        for (const gap of state.gaps) {
          if (evidenceStatusOf(gap) === 'verified') {
            gap.repairFailures = 0;
            state.clearRepairTerminal(gap.id);
          }
        }
      }
      addTrace(trace, state, 'slot_support', {
        reasonCode: support.unknown ? 'slot_support_unknown' : 'slot_support_judged',
        unknown: support.unknown,
        retried: support.retried,
        attempts: support.attempts,
        batches: support.batches,
        splitRetries: support.splitRetries,
        cacheHits: support.cacheHits,
        cacheMisses: support.cacheMisses,
        gapIds: support.judgments.map((item) => item.gapId).filter(Boolean),
        selectedSourceIds: (support.selections || []).flatMap((item) => item.selectedSourceIds || []),
        evidenceTypes: (support.selections || []).flatMap((item) => item.evidenceTypes || []),
        missingCriteria: (support.selections || []).flatMap((item) => item.missingCriteria || []),
        selections: (support.selections || []).map((item) => ({
          gapId: item.gapId,
          selectedSourceIds: item.selectedSourceIds,
          evidenceTypes: item.evidenceTypes,
          missingCriteria: item.missingCriteria,
          cacheHit: item.cacheHit,
        })),
      }, budget, support.unknown ? 'degraded' : 'success');
    }
    addTrace(trace, state, 'read', {
      reasonCode,
      targetGapIds: [finding.gapId],
      sourceIds,
      knowledgeCount: state.knowledge.length,
      harvest,
      decisionStep: !harvest,
      successfulBodies: successful,
      reads: classifiedSources.map((source) => ({
        sourceId: source.id || source.url,
        targetGapId: finding.gapId,
        discoveryGapIds: state.candidates.get(source.id || source.url)?.gapIds || [finding.gapId],
        query: state.candidates.get(source.id || source.url)?.gapMatches?.[finding.gapId]?.queries?.[0] || null,
        decision: source.relevanceDecision || null,
        matchedAlias: source.relevanceDecision?.matchedAlias || null,
        rejectionStage: source.relevanceDecision && source.relevanceDecision.accepted === false
          ? (source.bodyQuality === 'irrelevant' ? 'body' : 'pre-read')
          : null,
        selectReason: reasonCode,
      })),
    }, budget);
    return {
      successful,
      transportFailures,
      transportSkips,
      attempted,
      // Every attempted read failed, and every failure was the target refusing
      // or never delivering the bytes.
      transportOnly: successful === 0
        && attempted > 0
        && transportFailures + transportSkips === attempted,
      transportSkipOnly: successful === 0
        && attempted > 0
        && transportSkips === attempted,
    };
  };
}
