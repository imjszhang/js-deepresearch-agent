export { resolveRecoveryAction } from './exploratory-planning.mjs';
import { createReadExecutor } from './exploratory-read.mjs';
import { runActionExploration } from './exploratory-action-loop.mjs';
import { createSearchExecutor } from './exploratory-search.mjs';
import { createFinalizationGate } from './exploratory-finalization.mjs';
import { resolveReadSettings } from '../read-settings.mjs';
import { applyExploratoryBudget, effectiveExploratoryMaxSteps, resolveExploratorySettings } from '../exploratory-settings.mjs';
import { decideAdaptiveAction, fallbackAdaptiveAction, decomposeQuery, belowHardCapFrom, padFloorExploreAction, shouldSafetyCapInvalidStep } from '../adaptive/agent-policy.mjs';
import { ResearchState } from '../adaptive/research-state.mjs';
import { classifyResearchQuery } from '../adaptive/exploratory-sufficiency.mjs';
import { inferResearchProfile } from '../adaptive/research-profile.mjs';
import { applyContractGaps, planAndNormalizeContract } from '../research-contract.mjs';
import { isRepairTerminal } from '../gap-state.mjs';
import { mergeResearchBrief, researchBriefFromInput } from '../research-brief.mjs';
import { inferEvidenceScope, listLocalCorpusChannels } from '../adaptive/source-policy.mjs';
import { nextSlotRepairAction } from '../adaptive/slot-repair-scheduler.mjs';
import { checkpointHasTerminalLoopStop } from '../resume-plan.mjs';
import { attachPlannedQueries } from '../search-query-planner.mjs';
import {
  classifyInvalidReason,
  classifySearchProgress,
  isTransientSearchError,
} from '../../search/search-provider-error.mjs';
import { collectObservabilityMetrics } from '../observability.mjs';
import { resolveNewRunStopReason } from '../adaptive/stop-reasons.mjs';
import { abort, addTrace, loopCanAfford, hasStepCap, dynamicGapCount, countCapsExhausted, attachLoopMeta, selectedFinding, normalizeSearchQueries, plannerContext, plannerModeForGap, recordPlannerMetrics, filterDuplicateQueries, unresolvedRepairGaps, allUnresolvedBlocked, persistPlannerExhaustion, unlockPlannerTerminalsForHostRecovery, applyResumeExploreBudget, safetyStopDetail, readRejectionTrace, resolveRecoveryAction, STOP_REASONS, FINALIZE_ACTIONS } from './exploratory-planning.mjs';
export async function runExploratoryLoop(context) {
  const {
    query,
    llm,
    search,
    signal,
    emit,
    settings,
    budget,
    queryMemory,
    trace,
    researchProviders,
    recorder,
    restoredCheckpoint = null,
    continueExplore = false,
    extraSteps = 0,
    extraSearches = 0,
    extraReads = 0,
  } = context;
  const exploratory = resolveExploratorySettings(settings);
  const readPolicy = resolveReadSettings(settings, { strategy: 'exploratory' });
  const queryShape = classifyResearchQuery(query);
  if (restoredCheckpoint) {
    budget?.restoreCheckpoint?.(restoredCheckpoint.budget || {});
    applyResumeExploreBudget(budget, { extraSearches, extraReads });
  } else {
    applyExploratoryBudget(budget, exploratory);
  }
  const evidenceScope = inferEvidenceScope(settings);
  const incomingBrief = restoredCheckpoint?.brief
    || context.brief
    || researchBriefFromInput(query, { depth: 'exploratory' });
  let profile = restoredCheckpoint?.profile || inferResearchProfile(
    { ...incomingBrief, query },
    { settings, evidenceScope, depth: 'exploratory' },
  );
  if (!restoredCheckpoint) {
    profile.brief = mergeResearchBrief(incomingBrief, profile.brief, { query, depth: 'exploratory' });
  }
  let maxSteps = effectiveExploratoryMaxSteps(exploratory, budget?.limits?.llmTokens);
  if (restoredCheckpoint) {
    maxSteps = Number(restoredCheckpoint.maxSteps) || 0;
    if (continueExplore && extraSteps >= 1) {
      maxSteps = (Number(restoredCheckpoint.step) || 0) + extraSteps;
    }
  }
  const state = new ResearchState({
    query,
    maxSteps,
    maxGapDepth: exploratory.maxGapDepth,
    minLlmTokens: exploratory.minLlmTokens,
    targetLlmTokens: exploratory.minLlmTokens,
    budget,
    profile,
    settings,
    evidenceScope,
    brief: profile.brief || incomingBrief,
  });
  if (restoredCheckpoint) {
    state.restoreCheckpoint(restoredCheckpoint, { queryMemory });
    state.maxSteps = maxSteps;
  }
  state.transportMemory.setEventSink((event) => {
    addTrace(trace, state, 'transport_memory', {
      ...event,
      reasonCode: event.type,
    }, budget);
    recorder?.event?.('transport_memory', event);
  });
  const maxReads = Math.max(1, Number(exploratory.maxReadsPerStep) || 3);
  const maxRetries = Math.max(0, Number(exploratory.maxEvaluationRetries) || 0);
  const maxOpenGaps = Number(exploratory.maxOpenGaps) || 8;
  const maxQueriesPerStep = Math.max(1, Number(exploratory.maxQueriesPerStep) || 3);
  const autoReadTopK = Math.min(Math.max(0, Number(exploratory.autoReadTopK ?? 0)), maxReads);
  const answerGateEnabled = exploratory.answerGate !== false;
  const gateMode = exploratory.gateMode || 'rules-then-llm';
  const embedding = researchProviders?.embedding || null;
  if (embedding && queryMemory) {
    queryMemory.similarityProvider = embedding;
    queryMemory.semanticDedup = true;
  }
  const restoredLocal = restoredCheckpoint?.loopLocal || state.loopLocal || {};
  const loopLocal = {
    degraded: Boolean(restoredLocal.degraded),
    stopReason: continueExplore ? null : (restoredLocal.stopReason || null),
    stopDetail: continueExplore ? null : (restoredLocal.stopDetail || null),
    stopRequiredAmount: continueExplore ? null : (restoredLocal.stopRequiredAmount || null),
    pendingStopReason: continueExplore ? null : (restoredLocal.pendingStopReason || null),
    consecutiveInvalidSteps: continueExplore
    ? 0
    : (Number(restoredLocal.consecutiveInvalidSteps) || 0),
  };

  if (continueExplore) {
    unlockPlannerTerminalsForHostRecovery(state, restoredLocal.stopDetail);
    budget?.setControllerStopReason?.(null, null, null);
    if (budget) budget.stopReason = null;
  }
  const skipRestoredStop = Boolean(
    restoredCheckpoint
    && !continueExplore
    && checkpointHasTerminalLoopStop({ state: { loopLocal: restoredLocal, budget: restoredCheckpoint.budget } }),
  );
  const checkpointState = (boundary, extra = {}) => recorder?.checkpoint?.(
    boundary,
    state.exportCheckpoint({
      queryMemory,
      loopLocal: {
        consecutiveInvalidSteps: loopLocal.consecutiveInvalidSteps,
        stopReason: loopLocal.stopReason,
        stopDetail: loopLocal.stopDetail,
        stopRequiredAmount: loopLocal.stopRequiredAmount,
        pendingStopReason: loopLocal.pendingStopReason,
        degraded: loopLocal.degraded,
      },
    }),
    {
      strategy: 'exploratory',
      loopStep: state.step,
      traceLength: trace.length,
      ...extra,
    },
  );

  if (continueExplore) checkpointState('exploratory-continuation-start');
  if (restoredCheckpoint) {
    emit({
      stage: 'research_resumed',
      step: state.step,
      maxSteps: state.maxSteps,
      continueExplore,
    });
    addTrace(trace, state, 'resume', {
      reasonCode: continueExplore ? 'continue_explore' : 'mid_loop_resume',
      targetGapIds: state.gaps.map((gap) => gap.id),
      fromStep: restoredCheckpoint.step,
    }, budget);
  } else {
    emit({ stage: 'assessing_query', step: 0, maxSteps: state.maxSteps });
    emit({ stage: 'gap_opened', gapId: 'gap-1', question: query });
    addTrace(trace, state, 'assess', {
      reasonCode: 'exploratory_loop',
      targetGapIds: ['gap-1'],
      profile: {
        flags: profile.flags,
        requiredHosts: profile.requiredHosts,
        method: profile.method,
        evidenceScope,
        corpusChannelCount: listLocalCorpusChannels(settings).length,
      },
    }, budget);
  }

  function refreshState() {
    state.refreshBudgetView({
      budget,
      minLlmTokens: exploratory.minLlmTokens,
      actionCosts: state.actionCosts,
    });
    return state.readiness;
  }

  function canContinueLoop() {
    return (!hasStepCap(state.maxSteps) || state.step < state.maxSteps)
      && loopCanAfford(budget, state.actionCosts.estimate('search'))
      && !state.budgetView?.hardCapReached
      && !countCapsExhausted(budget);
  }

  const evaluateFinalization = createFinalizationGate({ state, loopLocal, emit, budget, llm, signal, trace, checkpointState, refreshState, canContinueLoop, maxRetries, answerGateEnabled, gateMode, maxOpenGaps });
  const performRead = createReadExecutor({ state, loopLocal, query, llm, signal, emit, settings, budget, embedding, recorder, readPolicy, maxReads, trace });

  const performSearch = createSearchExecutor({ state, search, settings, budget, emit, signal, queryMemory, llm, readPolicy, embedding, researchProviders, trace, maxQueriesPerStep, autoReadTopK, performRead });

  if (!restoredCheckpoint) {
    const profileTokensBefore = budget?.usage?.llmTokens || 0;
    const contract = await planAndNormalizeContract({
      llm,
      query,
      incomingBrief,
      settings,
      signal,
      evidenceScope,
      depth: 'exploratory',
    });
    profile = contract.profile;
    state.profile = profile;
    state.brief = contract.brief;
    state.evidenceScope = profile.evidenceScope || evidenceScope;
    applyContractGaps(state, contract, { maxGaps: maxOpenGaps });
    addTrace(trace, state, 'research_brief_sanitized', {
      reasonCode: contract.contractUnavailable ? 'contract_unavailable' : 'planner_output_validated',
      brief: state.brief,
      contractOrigin: state.brief?.contractOrigin,
      contractRetried: contract.contractRetried,
      contractFailure: contract.contractFailure,
    }, budget);
    state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - profileTokensBefore);

    if (contract.contractUnavailable) {
      loopLocal.stopReason = STOP_REASONS.safetyCap;
      loopLocal.stopDetail = 'contract_unavailable';
      addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.contractUnavailable }, budget, 'failed');
      budget?.setControllerStopReason?.(loopLocal.stopReason, loopLocal.stopDetail);
      refreshState();
      checkpointState('exploratory-contract-unavailable');
      emit({
        stage: 'research_stopped',
        reason: loopLocal.stopReason,
        step: state.step,
        maxSteps: state.maxSteps,
      });
      return attachLoopMeta(state.findings, {
        stopReason: loopLocal.stopReason,
        stopDetail: loopLocal.stopDetail,
        profile: state.profile,
        brief: state.brief,
        gaps: state.gaps,
        readiness: state.readiness,
        embeddingTraces: state.embeddingTraces,
        marginal: state.snapshot().marginal,
        relevance: state.snapshot().relevance,
        recovery: state.snapshot().recovery,
        transportMemory: state.transportMemory.snapshot(),
        ...state.unresolvedReportNotes(),
      });
    }

    if (queryShape.kind === 'definitional' || contract.slots.length) {
      addTrace(trace, state, 'decompose', {
        reasonCode: contract.slots.length ? 'decompose_skipped_slots' : 'decompose_skipped_definitional',
        targetGapIds: state.gaps.map((gap) => gap.id),
        subQuestionCount: 0,
      }, budget, 'skipped');
    } else {
      const tokensBefore = budget?.usage?.llmTokens || 0;
      const planned = (profile.plannedGaps || []).map((item) => item.question).filter(Boolean);
      const subQuestions = planned.length
        ? planned
        : await decomposeQuery({ llm, state, signal });
      state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
      for (const question of subQuestions) {
        if (dynamicGapCount(state) >= maxOpenGaps) break;
        const plannedGap = (profile.plannedGaps || []).find((item) => item.question === question);
        const gap = state.addGap(question, plannedGap?.priority || 'normal', {
          requiredHosts: plannedGap?.requiredHosts,
        });
        if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
      }
      addTrace(trace, state, 'decompose', {
        reasonCode: subQuestions.length ? 'query_decomposed' : 'decompose_skipped',
        targetGapIds: state.gaps.map((gap) => gap.id),
        subQuestionCount: subQuestions.length,
      }, budget, subQuestions.length ? 'success' : 'skipped');
    }
  }

  try {
    if (state.scheduler && !skipRestoredStop) await runActionExploration({ state, loopLocal, query, llm, search, signal, emit, budget, queryMemory, recorder,
      trace, readPolicy, exploratory, performSearch, performRead, refreshState, checkpointState, continueExplore });
    while (!state.scheduler && !skipRestoredStop && (!hasStepCap(state.maxSteps) || state.step < state.maxSteps)) {
      abort(signal);
      const gate = refreshState();
      if (state.step === 0 && !restoredCheckpoint) {
        checkpointState('exploratory-bootstrap', { readinessPass: Boolean(gate?.pass) });
      }

      if (budget && !loopCanAfford(budget, state.actionCosts.estimate('decide'))) {
        loopLocal.stopReason = STOP_REASONS.budgetExhausted;
        loopLocal.stopRequiredAmount = state.actionCosts.estimate('decide');
        loopLocal.stopDetail = budget.exhaustionDetail?.({ llmClaim: loopLocal.stopRequiredAmount }) || 'llm_hard_cap';
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, stopDetail: loopLocal.stopDetail }, budget, 'budget_exhausted');
        break;
      }

      const belowMin = Boolean(state.budgetView?.belowMin);
      const belowHardCap = belowHardCapFrom(state);
      let action;
      if (state.budgetView?.hardCapReached) {
        loopLocal.stopReason = STOP_REASONS.budgetExhausted;
        loopLocal.stopDetail = budget?.exhaustionDetail?.({ llmClaim: 1 }) || 'llm_hard_cap';
        addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.budgetExhausted, stopDetail: loopLocal.stopDetail }, budget, 'budget_exhausted');
        break;
      } else if (countCapsExhausted(budget)) {
        action = { action: 'answer', reasonCode: STOP_REASONS.budgetExhausted };
        loopLocal.stopDetail = budget.exhaustionDetail?.({ llmClaim: 0 });
        loopLocal.pendingStopReason = STOP_REASONS.budgetExhausted;
        loopLocal.degraded = true;
      } else if (gate?.pass && !belowMin) {
        action = { action: 'answer', reasonCode: 'evidence_sufficient' };
      } else {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        action = await decideAdaptiveAction({ llm, state, signal });
        state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
        if (
          !action
          || (
            FINALIZE_ACTIONS.has(action.action)
            && (belowMin || state.forbidFinalizeUntilExplore)
            && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted
            && loopLocal.pendingStopReason !== STOP_REASONS.safetyCap
          )
        ) {
          action = fallbackAdaptiveAction(state, {
            belowMin,
            belowHardCap,
            readiness: gate,
            sufficiency: state.sufficiency,
          });
        }
        if (state.marginal.plateau && action?.action === 'search') {
          action = {
            ...action,
            plannerMode: 'angle_change',
            needsPlanner: action.queryOrigin !== 'user_query',
            reasonCode: 'plateau_change_angle',
          };
          addTrace(trace, state, 'plateau', {
            reasonCode: 'exploratory_action_redirected',
            marginal: { ...state.marginal },
            originalAction: 'search',
            nextAction: action.action,
          }, budget);
        }
        if (FINALIZE_ACTIONS.has(action?.action) && !gate?.pass && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted) {
          action = {
            ...action,
            blockedByGate: true,
          };
        }
      }

      if (action?.action === 'search'
        && state.getGap(action.gapId)?.rollup
        && !gate?.pass
        && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted) {
        const repair = nextSlotRepairAction(state, { readiness: gate });
        if (repair?.gapId && state.getGap(repair.gapId)?.requiredSlot) {
          const originalAction = action;
          action = repair.action === 'search' ? {
            ...action,
            gapId: repair.gapId,
            plannerMode: action.plannerMode || repair.plannerMode || 'repair',
            needsPlanner: action.queryOrigin !== 'user_query',
            reasonCode: action.reasonCode || repair.reasonCode,
            repairTarget: repair.gapId,
          } : { ...repair, repairTarget: repair.gapId };
          addTrace(trace, state, 'search_redirect', {
            reasonCode: 'rollup_to_required_slot',
            targetGapIds: [repair.gapId],
            originalAction: originalAction.action,
            nextAction: action.action,
          }, budget);
        }
      }
      if (action?.action === 'read' && state.getGap(action.gapId)?.rollup && !gate?.pass
        && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted) {
        const sourceGapId = action.sourceIds
          ?.map((id) => state.candidates.get(id)?.gapId)
          .find((gapId) => gapId && !state.getGap(gapId)?.rollup);
        const repair = sourceGapId
          ? { gapId: sourceGapId }
          : nextSlotRepairAction(state, { readiness: gate, maxQueries: maxQueriesPerStep });
        if (repair?.gapId && (sourceGapId || state.getGap(repair.gapId)?.requiredSlot)) {
          action = { ...action, gapId: repair.gapId, repairTarget: repair.gapId };
          addTrace(trace, state, 'read_redirect', {
            reasonCode: 'rollup_to_required_slot',
            targetGapIds: [repair.gapId],
          }, budget);
        }
      }

      if (
        action?.action === 'search'
        && action.queryOrigin !== 'user_query'
        && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted
      ) {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        let planned;
        const plannedMode = plannerModeForGap(
          state,
          state.getGap(action.gapId || state.focusGap()?.id),
          action.plannerMode || (state.marginal.plateau ? 'angle_change' : 'repair'),
        );
        action = { ...action, plannerMode: plannedMode };
        try {
          planned = await attachPlannedQueries(action, {
            ...plannerContext(state, {
              llm,
              signal,
              queryMemory,
              gate,
              search,
              gap: state.getGap(action.gapId || state.focusGap()?.id),
            }),
            mode: plannedMode,
            gap: state.getGap(action.gapId || state.focusGap()?.id),
            gapId: action.gapId || state.focusGap()?.id,
            limit: maxQueriesPerStep,
          });
        } catch (error) {
          if (error?.name === 'AbortError' || error?.name === 'BudgetExceededError') throw error;
          planned = {
            action: {
              ...action,
              query: '',
              queries: [],
              planFailure: 'planner_exception',
            },
            plan: {
              ok: false,
              failure: 'planner_exception',
              reasonCode: 'search_query_failed',
              dedup: { rejected: [] },
              errorMessage: String(error?.message || 'planner_exception').slice(0, 240),
            },
          };
        }
        state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
        recordPlannerMetrics(state, planned.plan, {
          gapId: planned.action?.gapId || action.gapId,
          stage: planned.action?.plannerMode || action.plannerMode || 'repair',
        });
        addTrace(trace, state, 'search_query_planned', {
          reasonCode: planned.plan?.reasonCode || planned.action?.planFailure || 'search_query_failed',
          plannerMode: planned.action?.plannerMode || action.plannerMode,
          queryOrigin: planned.action?.queryOrigin || null,
          queries: planned.action?.queries || [],
          failure: planned.plan?.failure || planned.action?.planFailure || null,
          errorMessage: planned.plan?.errorMessage || null,
          targetGapIds: [planned.action?.gapId || action.gapId].filter(Boolean),
        }, budget, planned.plan?.ok ? 'success' : 'failed');
        action = planned.action;
      }

      const queryScope = { evidenceScope: state.evidenceScope || evidenceScope };
      const floorPadding = belowMin && Boolean(gate?.pass);
      if (floorPadding && action?.action === 'read') {
        const redirected = padFloorExploreAction(state, action, {
          belowMin,
          belowHardCap,
          readiness: gate,
        });
        if (redirected !== action) {
          addTrace(trace, state, 'read', {
            reasonCode: 'below_min_skip_repeat_read',
            sourceIds: action.sourceIds,
            targetGapIds: [action.gapId].filter(Boolean),
            nextAction: redirected?.action || null,
          }, budget, 'skipped');
          action = redirected;
        }
      }
      let invalid = loopLocal.pendingStopReason === STOP_REASONS.budgetExhausted ? null : state.validate(action);
      let searchQueries = [];
      if (!invalid && action.action === 'search') {
        const gap = state.getGap(action.gapId || state.focusGap()?.id);
        const rawQueries = normalizeSearchQueries(action, maxQueriesPerStep, queryScope);
        searchQueries = await filterDuplicateQueries(rawQueries.slice(0, maxQueriesPerStep), {
          state,
          queryMemory,
          gapId: gap.id,
          embedding,
          signal,
        });
        if (!searchQueries.length) invalid = 'duplicate_query';
      }
      if (invalid) {
        state.recovery.invalidSteps += 1;
        state.recovery.recoveryRounds += 1;
        state.observations.push({ type: 'invalid_action', reason: invalid, action: action?.action || null });
        state.addDiary(`${action?.action || 'unknown'} rejected (${invalid})`);
        addTrace(trace, state, action?.action || 'unknown', action?.action === 'read'
          ? readRejectionTrace(state, action, invalid)
          : { reasonCode: invalid }, budget, 'rejected');
        if (classifyInvalidReason(invalid) === 'cap') {
          const resolvedStop = resolveNewRunStopReason(invalid, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          }) || STOP_REASONS.safetyCap;
          loopLocal.stopReason = resolvedStop;
          loopLocal.stopDetail = resolvedStop === STOP_REASONS.budgetExhausted
            ? budget?.exhaustionDetail?.({ llmClaim: 1 })
            : (resolvedStop === STOP_REASONS.safetyCap ? 'max_steps' : null);
          addTrace(trace, state, 'stop', { reasonCode: loopLocal.stopReason, stopDetail: loopLocal.stopDetail }, budget);
          break;
        }
        const requestedRecoveryGapId = action?.gapId || state.focusGap()?.id;
        const requestedRecoveryGap = state.getGap(requestedRecoveryGapId);
        const rotateRepair = ['duplicate', 'relevance_rejected'].includes(classifyInvalidReason(invalid))
          || requestedRecoveryGap?.rollup
          || isRepairTerminal(requestedRecoveryGap);
        const recoveryGapId = rotateRepair
          ? (nextSlotRepairAction(state, { readiness: gate, maxQueries: maxQueriesPerStep })?.gapId || requestedRecoveryGapId)
          : requestedRecoveryGapId;
        const tokensBefore = budget?.usage?.llmTokens || 0;
        action = belowHardCap && canContinueLoop()
          ? await resolveRecoveryAction(state, {
            llm,
            gate,
            signal,
            queryMemory,
            embedding,
            maxQueriesPerStep,
            gapId: recoveryGapId,
            rejectedQueries: [{ query: action?.query || '', reason: invalid }],
            search,
          })
          : null;
        state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
        invalid = action ? state.validate(action) : 'no_repair_action';
        if (!invalid && action.action === 'search') {
          searchQueries = normalizeSearchQueries(action, maxQueriesPerStep, queryScope);
          if (!searchQueries.length) invalid = 'duplicate_query';
        }
        if (invalid) {
          const kind = classifyInvalidReason(invalid);
          state.noteProgressKind(kind === 'semantic' ? 'semantic_no_yield' : kind);
          if (floorPadding && !shouldSafetyCapInvalidStep(invalid, { belowMin, gatePass: true })) {
            state.step += 1;
            state.observations.push({ type: 'recovery_advanced', reason: 'floor_idle_no_new_work' });
            addTrace(trace, state, 'recovery', {
              reasonCode: 'floor_idle_no_new_work',
              originalInvalid: invalid,
              recoveryState: 'idle',
              targetGapIds: [state.focusGap()?.id].filter(Boolean),
            }, budget, 'retry');
            checkpointState('exploratory-step-complete', {
              action: 'recovery',
              outcome: 'floor_idle_no_new_work',
            });
            continue;
          }
          if (kind === 'semantic') loopLocal.consecutiveInvalidSteps += 1;
          const failedGap = state.getGap(recoveryGapId);
          if (kind === 'semantic' && failedGap && !failedGap.rollup && !isRepairTerminal(failedGap)) {
            failedGap.repairFailures = (Number(failedGap.repairFailures) || 0) + 1;
            if (failedGap.repairFailures >= exploratory.maxRepairFailuresPerGap) {
              const filteredAll = (failedGap.filteredQueries || []).some((item) => item?.reason === 'site_filtered_all');
              const unreachableRequired = (failedGap.requiredHosts || []).length > 0;
              state.markRepairTerminal(
                failedGap.id,
                filteredAll ? 'site_filtered_all' : (unreachableRequired ? 'required_host_unreachable' : 'repair_exhausted'),
                { phase: 'repair' },
              );
            }
          }
          const consecutiveCap = loopLocal.consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps;
          if (consecutiveCap && failedGap && !failedGap.rollup && !isRepairTerminal(failedGap)) {
            state.markRepairTerminal(failedGap.id, 'repair_exhausted', { phase: 'recovery' });
          }
          const blockedAll = allUnresolvedBlocked(state, gate);
          if (blockedAll || consecutiveCap) {
            loopLocal.stopReason = STOP_REASONS.safetyCap;
            loopLocal.stopDetail = safetyStopDetail(state, {
              trigger: consecutiveCap && !blockedAll ? 'consecutive_invalid' : 'all_unresolved_blocked',
            });
            addTrace(trace, state, 'stop', {
              reasonCode: loopLocal.stopReason,
              stopDetail: loopLocal.stopDetail,
              targetGapIds: unresolvedRepairGaps(state, gate).map((gap) => gap.id),
            }, budget);
            break;
          }
          const resolvedStop = resolveNewRunStopReason(loopLocal.pendingStopReason, {
            step: state.step,
            maxSteps: state.maxSteps,
            budget,
          });
          if (resolvedStop) {
            loopLocal.stopReason = resolvedStop;
            loopLocal.stopDetail = resolvedStop === STOP_REASONS.budgetExhausted
              ? budget?.exhaustionDetail?.({ llmClaim: 1 })
              : (resolvedStop === STOP_REASONS.safetyCap ? 'max_steps' : null);
            addTrace(trace, state, 'stop', { reasonCode: loopLocal.stopReason, stopDetail: loopLocal.stopDetail }, budget);
            break;
          }
          state.step += 1;
          state.observations.push({ type: 'recovery_advanced', reason: invalid });
          addTrace(trace, state, 'recovery', {
            reasonCode: invalid,
            recoveryState: 'advanced',
            targetGapIds: [state.focusGap()?.id].filter(Boolean),
          }, budget, 'retry');
          checkpointState('exploratory-step-complete', {
            action: 'recovery',
            outcome: invalid,
          });
          continue;
        }
      }
      const stepsRemaining = hasStepCap(state.maxSteps) ? state.maxSteps - state.step : null;
      if (stepsRemaining !== null && stepsRemaining <= 1 && !FINALIZE_ACTIONS.has(action.action)
        && (state.findings.length > 0 || state.candidates.size > 0)) {
        addTrace(trace, state, action.action, { reasonCode: 'forced_final_answer' }, budget, 'forced');
        state.forbidFinalizeUntilExplore = false;
        action = { action: 'answer', reasonCode: 'forced_final_answer' };
        loopLocal.pendingStopReason = STOP_REASONS.safetyCap;
      }
      state.step += 1;
      state.lastAction = action.action;
      abort(signal);

      if (action.action === 'search') {
        const { gap, gapId, newUrls, totalResults, successfulAutoReads, searchResults, duplicateSerp } = await performSearch(action, searchQueries, gate);
        const progressKind = (newUrls > 0 || totalResults > 0 || successfulAutoReads > 0)
          ? 'progress'
          : classifySearchProgress({
            error: searchResults.find((item) => isTransientSearchError(item.error))?.error || null,
            skipped: duplicateSerp ? 'duplicate_results' : null,
            newUrls,
            resultCount: totalResults,
          });
        state.noteProgressKind(progressKind);
        if (progressKind === 'progress') {
          loopLocal.consecutiveInvalidSteps = 0;
          if (gap && !gap.rollup) gap.repairFailures = 0;
          state.clearPlannerFailure({ gapId });
        } else if (progressKind === 'transient' || progressKind === 'duplicate') {
          addTrace(trace, state, 'recovery', {
            reasonCode: progressKind === 'transient' ? 'transient_provider_error' : 'duplicate_no_yield',
            recoveryState: progressKind,
            targetGapIds: [gapId],
          }, budget, 'retry');
        } else {
          loopLocal.consecutiveInvalidSteps += 1;
          state.recovery.invalidSteps += 1;
          addTrace(trace, state, 'recovery', {
            reasonCode: 'zero_evidence_action',
            recoveryState: 'no_yield',
            targetGapIds: [gapId],
            consecutiveInvalidSteps: loopLocal.consecutiveInvalidSteps,
          }, budget, 'retry');
          if (loopLocal.consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps) {
            if (gap && !gap.rollup && !isRepairTerminal(gap)) {
              state.markRepairTerminal(gap.id, 'repair_exhausted', { phase: 'search' });
            }
            loopLocal.stopReason = STOP_REASONS.safetyCap;
            loopLocal.stopDetail = safetyStopDetail(state, { trigger: 'consecutive_invalid' });
            addTrace(trace, state, 'stop', {
              reasonCode: loopLocal.stopReason,
              stopDetail: loopLocal.stopDetail,
              targetGapIds: [gapId],
            }, budget);
            break;
          }
        }
        checkpointState('exploratory-step-complete', {
          action: 'search',
          outcome: progressKind,
        });
        continue;
      }

      if (action.action === 'read') {
        state.forbidFinalizeUntilExplore = false;
        const targetGapId = action.gapId || state.focusGap()?.id;
        const requestedSourceIds = [...new Set(action.sourceIds)];
        const rejectedSourceIds = requestedSourceIds.filter((id) => {
          const decision = state.candidateDecisionForGap(state.candidates.get(id), targetGapId);
          return decision?.accepted === false;
        });
        const eligibleSourceIds = requestedSourceIds
          .filter((id) => !rejectedSourceIds.includes(id))
          .filter((id) => !state.readSourceIds.has(id))
          .slice(0, maxReads);
        if (rejectedSourceIds.length) {
          addTrace(trace, state, 'read_sources_filtered', {
            reasonCode: 'partial_relevance_rejection',
            targetGapIds: [targetGapId].filter(Boolean),
            sourceIds: rejectedSourceIds,
          }, budget, 'skipped');
        }
        const readOutcome = await performRead({
          sourceIds: eligibleSourceIds,
          gapId: targetGapId,
          reasonCode: action.reasonCode || 'agent_read',
          harvest: false,
        });
        const successfulReads = readOutcome.successful;
        if (successfulReads > 0) {
          loopLocal.consecutiveInvalidSteps = 0;
          const readGap = state.getGap(action.gapId);
          if (readGap && !readGap.rollup) readGap.repairFailures = 0;
          state.clearPlannerFailure({ gapId: action.gapId });
        } else if (readOutcome.transportSkipOnly) {
          // No network request happened, so this cannot count as an invalid
          // planner step or as a new transport failure at any token level.
          addTrace(trace, state, 'recovery', {
            reasonCode: 'transport_skipped_read',
            recoveryState: 'transport_skipped',
            targetGapIds: [targetGapId].filter(Boolean),
            transportFailures: 0,
            transportSkips: readOutcome.transportSkips,
            blockedHosts: Object.keys(state.recovery.transportBlockedHosts || {}),
          }, budget, 'retry');
        } else if (readOutcome.transportOnly && belowMin) {
          // The targets refused or never delivered the bytes. That is not the
          // loop failing to find valid actions, and it must not burn the
          // safety valve while the exploration floor is still unmet.
          addTrace(trace, state, 'recovery', {
            reasonCode: 'transport_blocked_read',
            recoveryState: 'transport_blocked',
            targetGapIds: [targetGapId].filter(Boolean),
            transportFailures: readOutcome.transportFailures,
            transportSkips: readOutcome.transportSkips,
            blockedHosts: Object.keys(state.recovery.transportBlockedHosts || {}),
          }, budget, 'retry');
        } else if (!(belowMin && gate?.pass)) {
          loopLocal.consecutiveInvalidSteps += 1;
          state.recovery.invalidSteps += 1;
          if (loopLocal.consecutiveInvalidSteps >= exploratory.maxConsecutiveInvalidSteps) {
            const failedGap = state.getGap(targetGapId);
            if (failedGap && !failedGap.rollup && !isRepairTerminal(failedGap)) {
              state.markRepairTerminal(failedGap.id, 'repair_exhausted', { phase: 'read' });
            }
            loopLocal.stopReason = STOP_REASONS.safetyCap;
            loopLocal.stopDetail = safetyStopDetail(state, {
              trigger: 'consecutive_invalid',
              transportOnly: readOutcome.transportOnly,
            });
            addTrace(trace, state, 'stop', {
              reasonCode: loopLocal.stopReason,
              stopDetail: loopLocal.stopDetail,
              targetGapIds: [action.gapId].filter(Boolean),
            }, budget);
            break;
          }
        }
        checkpointState('exploratory-step-complete', {
          action: 'read',
          successfulReads,
        });
        continue;
      }

      if (action.action === 'reflect') {
        let gapQuestion = String(action.gapQuestion || '').trim();
        if (!gapQuestion && dynamicGapCount(state) < maxOpenGaps) {
          const tokensBefore = budget?.usage?.llmTokens || 0;
          const suggestions = await decomposeQuery({ llm, state, signal, maxSubQuestions: 1 });
          state.actionCosts.record('reflect', (budget?.usage?.llmTokens || 0) - tokensBefore);
          gapQuestion = suggestions.find((question) => !state.gaps.some((gap) => gap.question === question)) || '';
        }
        if (gapQuestion && dynamicGapCount(state) < maxOpenGaps) {
          const gap = state.addGap(gapQuestion);
          if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
          else gapQuestion = '';
        }
        if (gapQuestion) loopLocal.consecutiveInvalidSteps = 0;
        else loopLocal.consecutiveInvalidSteps += 1;
        state.addDiary(gapQuestion ? `reflected, opened gap "${gapQuestion.slice(0, 80)}"` : 'reflected, no new gap');
        addTrace(trace, state, 'reflect', { reasonCode: action.reasonCode || 'agent_reflect', targetGapIds: state.gaps.map((gap) => gap.id), decisionStep: true }, budget);
        checkpointState('exploratory-step-complete', {
          action: 'reflect',
          openedGap: Boolean(gapQuestion),
        });
        continue;
      }

      if (FINALIZE_ACTIONS.has(action.action)) {
        if (await evaluateFinalization(action, belowMin) === 'continue') continue;
        break;
      }

      loopLocal.stopReason = resolveNewRunStopReason(action.reasonCode, {
        step: state.step,
        maxSteps: state.maxSteps,
        budget,
      });
      addTrace(trace, state, 'stop', { reasonCode: action.reasonCode || loopLocal.stopReason }, budget);
      break;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      loopLocal.stopReason = STOP_REASONS.userCancelled;
      addTrace(trace, state, 'stop', { reasonCode: STOP_REASONS.userCancelled }, budget, 'cancelled');
    } else if (error?.name !== 'BudgetExceededError') {
      loopLocal.stopReason = STOP_REASONS.safetyCap;
      loopLocal.stopDetail = 'loop_exception';
      addTrace(trace, state, 'stop', {
        reasonCode: STOP_REASONS.safetyCap,
        stopDetail: loopLocal.stopDetail,
        errorName: error?.name || 'Error',
        errorMessage: String(error?.message || '').slice(0, 240),
      }, budget, 'failed');
      emit({
        stage: 'research_stopped',
        reason: `loop_exception: ${String(error?.message || error).slice(0, 240)}`,
      });
    } else {
      loopLocal.degraded = true;
      loopLocal.stopReason = STOP_REASONS.budgetExhausted;
      loopLocal.stopRequiredAmount = error.requiredAmount || 1;
      loopLocal.stopDetail = budget?.exhaustionDetail?.({ llmClaim: loopLocal.stopRequiredAmount })
        || ({ searchRequests: 'search_request_cap', sourceReads: 'source_read_cap', llmTokens: 'llm_hard_cap' }[error.kind])
        || error.kind;
      addTrace(trace, state, 'stop', {
        reasonCode: STOP_REASONS.budgetExhausted,
        stopDetail: loopLocal.stopDetail,
        kind: error.kind,
      }, budget, 'budget_exhausted');
    }
  }

  if (loopLocal.stopReason) {
    state.scheduler?.stop(loopLocal.stopReason, loopLocal.stopDetail);
    checkpointState('exploratory-loop-complete', {
      stopReason: loopLocal.stopReason,
      stopDetail: loopLocal.stopDetail,
    });
  }

  if (!loopLocal.stopReason) {
    loopLocal.stopReason = resolveNewRunStopReason(null, {
      step: state.step,
      maxSteps: state.maxSteps,
      budget,
    });
  }
  if (!(loopLocal.stopReason === STOP_REASONS.budgetExhausted && loopLocal.stopDetail)) {
    loopLocal.stopReason = resolveNewRunStopReason(loopLocal.stopReason, {
      step: state.step,
      maxSteps: state.maxSteps,
      budget,
    });
  }
  if (!loopLocal.stopReason && hasStepCap(state.maxSteps) && state.step >= state.maxSteps) {
    loopLocal.stopReason = STOP_REASONS.safetyCap;
    loopLocal.stopDetail = 'max_steps';
  }

  if (state.findings.length === 0 && state.candidates.size > 0) {
    const fallbackFinding = selectedFinding(state, [...state.candidates.keys()], 'gap-1');
    fallbackFinding.degraded = true;
    state.findings.push(fallbackFinding);
  }
  const recoverySnapshot = state.snapshot().recovery;
  if (loopLocal.degraded) {
    for (const finding of state.findings) finding.degraded = true;
  }
  const notes = state.unresolvedReportNotes();
  const blockedSlots = recoverySnapshot.blockedGaps.filter((entry) => {
    const gap = state.getGap(entry.gapId);
    return gap && !gap.rollup;
  });
  for (const finding of state.findings) {
    finding.unresolvedGaps = notes.unresolvedGaps;
    finding.unresolvedRequiredHostCommitments = notes.unresolvedRequiredHostCommitments;
    finding.blockedHosts = notes.blockedHosts;
    finding.secondaryOnlyClaims = notes.secondaryOnlyClaims;
    finding.unsupportedDecisions = notes.unsupportedDecisions;
    finding.blockedSlots = blockedSlots;
  }
  if (loopLocal.stopReason === STOP_REASONS.budgetExhausted && !loopLocal.stopDetail) {
    loopLocal.stopDetail = budget?.exhaustionDetail?.({ llmClaim: budget?.defaultLlmMaxTokens || 1 }) || null;
  }
  persistPlannerExhaustion(state, loopLocal.stopDetail);
  budget?.setControllerStopReason?.(loopLocal.stopReason, loopLocal.stopDetail, loopLocal.stopRequiredAmount);
  refreshState();
  checkpointState('exploratory-loop-complete', {
    stopReason: loopLocal.stopReason,
    stopDetail: loopLocal.stopDetail,
  });
  emit({
    stage: 'research_stopped',
    reason: loopLocal.stopReason,
    step: state.step,
    maxSteps: state.maxSteps,
  });
  return attachLoopMeta(state.findings, {
    evidenceStore: state.evidenceStore?.export() || null,
    scheduler: state.scheduler?.export() || null,
    embeddingCache: embedding?.stats ? { ...embedding.stats } : null,
    stopReason: loopLocal.stopReason,
    stopDetail: loopLocal.stopDetail,
    profile: state.profile,
    brief: state.brief,
    gaps: state.gaps,
    readiness: state.readiness,
    embeddingTraces: state.embeddingTraces,
    marginal: state.snapshot().marginal,
    relevance: state.snapshot().relevance,
    recovery: state.snapshot().recovery,
    transportMemory: state.transportMemory.snapshot(),
    searchOutcomes: state.searchOutcomes,
    observability: collectObservabilityMetrics({
      findings: state.findings,
      trace,
      searchOutcomes: state.searchOutcomes,
      agentSnapshotChars: state.lastAgentSnapshotChars,
      transportMemory: state.transportMemory,
    }),
    ...notes,
  });
}
