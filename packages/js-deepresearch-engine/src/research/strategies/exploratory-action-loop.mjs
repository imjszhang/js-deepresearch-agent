import { evaluateSourceRelevance } from '../adaptive/source-policy.mjs';
import { planSearchQueries, validatePlannedQuery } from '../search-query-planner.mjs';
import { applySlotSupportJudgments, judgeOpenSlotSupport, selectSlotPassages } from '../gap-slot-support.mjs';
import { addTrace, plannerContext, recordPlannerMetrics } from './exploratory-planning.mjs';
import { isExecutionInterruption } from '../../search/search-health.mjs';
import { buildClaimGraph, deliverableBinding } from '../claim-graph.mjs';
import { validateResearchClaims, applyValidatedBindings } from '../claim-validation.mjs';

function stateCounts(state) {
  return { candidates: state.candidates.size, versions: state.evidenceStore.versions.size,
    inspections: state.evidenceStore.inspections.size,
    validatedClaims: state.validatedClaimIds?.length || 0,
    verified: state.gaps.filter((gap) => !gap.rollup && gap.status === 'verified').length };
}
function semanticProgress(state) {
  return JSON.stringify({ claims: state.validatedClaimIds || [],
    completedTasks: state.gaps.filter(g => !g.rollup && g.claimValidation?.complete && g.status === 'verified').map(g => g.id).sort() });
}
function dependencies(state, gapId) {
  return [...state.evidenceStore.associations.values()].filter((entry) => entry.taskId === gapId && entry.relevance?.accepted !== false).map((entry) => entry.documentVersionId).sort();
}

export async function runActionExploration({ state, loopLocal, query, llm, search, signal, emit, budget, queryMemory,
  trace, readPolicy, exploratory, recorder, performSearch, performRead, refreshState, checkpointState, continueExplore = false }) {
  const scheduler = state.scheduler;
  if (continueExplore) scheduler.continueSegment();
  scheduler.recover();
  for (const action of scheduler.actions.values()) {
    if (!scheduler.terminal && (action.status === 'outcome_unknown' || (continueExplore && action.status === 'interrupted')) && action.attemptCount < scheduler.maxFailures) action.status = 'pending';
  }
  if (scheduler.terminal) {
    loopLocal.stopReason = scheduler.terminal.reason; loopLocal.stopDetail = scheduler.terminal.detail; return;
  }
  const canRun = (action) => {
    if (recorder?.hasRecoverable?.(null, { actionId: action.actionId })) return true;
    if (action.type === 'search') return performSearch.canReuse?.(action.inputRefs.query, action.inputRefs.searchOptions) || !budget || budget.canClaim('searchRequests');
    if (action.type === 'read_candidate') return !budget || budget.canClaim('sourceReads');
    return !budget || budget.canClaim('llmTokens', 1);
  };
  const stop = (reason, detail) => {
    scheduler.stop(reason, detail); loopLocal.stopReason = reason; loopLocal.stopDetail = detail;
    checkpointState('exploratory-loop-complete', { stopReason: reason, stopDetail: detail });
  };
  let noChangeCycles = scheduler.noChangeCycles || 0;
  let cycleStart = scheduler.cycleStart || semanticProgress(state);
  const planningTurns = scheduler.planningTurns;
  function seedLocal() {
    state.evidenceStore.captureFindings(state.findings);
    const tasks = state.gaps.filter((gap) => !gap.rollup);
    for (const gap of tasks) {
      for (const version of state.evidenceStore.versions.values()) {
        if ([...state.evidenceStore.associations.values()].some((item) => item.taskId === gap.id && item.documentVersionId === version.documentVersionId)) continue;
        const source = { id: version.sourceId, canonicalSourceId: version.sourceId, documentVersionId: version.documentVersionId,
          title: version.title, url: version.url, content: state.evidenceStore.body(version.documentVersionId), fetchStatus: 'ok', contentOrigin: 'provided' };
        const decision = evaluateSourceRelevance(source, { ...readPolicy.relevance, gap, query: gap.question,
          entities: state.brief.entities || [], entityAliases: state.brief.entityAliases || [], rerankProvider: 'disabled', allowRequiredHostProbe: false });
        state.evidenceStore.associate(gap.id, version.documentVersionId, { relevanceDecision: decision });
        if (decision.accepted) state.findings.push({ id: `reuse-${gap.id}-${version.documentVersionId}`, gapId: gap.id,
          contractSlotId: gap.contractSlotId, question: gap.question, origin: 'document_reuse', sources: [{ ...source, relevanceDecision: decision }] });
      }
      const base = { targetTaskIds: [gap.id], required: Boolean(gap.requiredSlot), evidenceDependencies: dependencies(state, gap.id), constraintRevision: 1 };
      const unseen = selectSlotPassages(gap, state.findings, { query, brief: state.brief, profile: state.profile,
        evidenceStore: state.evidenceStore, inspectUnseen: true, topK: 5 });
      if (unseen.length) scheduler.enqueue({ ...base, type: gap.status === 'verified' ? 'check_conflict' : 'inspect_document', inputRefs: { passageIds: unseen.map((passage) => passage.id) } });
      for (const candidate of state.pickPolicyReads(3, gap.id)) {
        scheduler.enqueue({ ...base, type: 'read_candidate', inputRefs: { sourceIds: [candidate.id || candidate.url] } });
      }
    }
  }

  while (!scheduler.terminal) {
    if (signal?.aborted) { stop('user_cancelled', null); signal.throwIfAborted(); }
    seedLocal();
    const graph = buildClaimGraph({ gaps: state.gaps, passages: [...state.evidenceStore.passages.values()] });
    if (graph.records.length) {
      const validation = await validateResearchClaims({ graph, store: state.evidenceStore, gaps: state.gaps, query,
        llm, signal, recorder, budget, constraints: state.brief.constraints || [], cache: state.claimValidationCache });
      applyValidatedBindings(state.gaps, validation.graph);
      state.claimValidationCache = validation.cache;
      state.validatedClaimIds = [...new Set(graph.bindings.filter(deliverableBinding).map(b => b.claimId))].sort();
      if (validation.newValidationCount) checkpointState('exploratory-step-complete', { action: 'validate_claims', count: validation.newValidationCount });
    }
    const gate = refreshState();
    if (gate?.pass && (graph.bindings.some(b => b.required && b.adequacy !== 'verified')
      || (state.brief.constraints || []).some(c => c.validationStatus === 'unresolved'))) gate.pass = false;
    if (gate?.pass && budget?.snapshot().floorStatus === 'met') { stop('evidence_sufficient', null); break; }
    if (state.maxSteps > 0 && state.step >= state.maxSteps && ![...scheduler.actions.values()].some((item) => item.status === 'pending' && recorder?.hasRecoverable?.(null, { actionId: item.actionId }))) { stop('safety_cap', 'max_steps'); break; }
    let action = scheduler.next({ canRun });
    if (!action) {
      const counts = semanticProgress(state);
      if (counts !== cycleStart) { noChangeCycles = 0; scheduler.surveyTaskIds = []; }
      cycleStart = counts; scheduler.cycleStart = counts;
      scheduler.noChangeCycles = noChangeCycles;
      const gaps = state.gaps.filter((gap) => !gap.rollup && scheduler.canPlan(gap.id, dependencies(state, gap.id)))
        .sort((a, b) => (planningTurns.get(a.id) || 0) - (planningTurns.get(b.id) || 0)
          || Number(b.requiredSlot) - Number(a.requiredSlot));
      if (!gaps.length) { stop('safety_cap', 'action_frontier_exhausted'); break; }
      if (budget && (!budget.canClaim('llmTokens', 1) || !budget.canClaim('searchRequests'))) {
        stop('budget_exhausted', budget.exhaustionDetail({ llmClaim: 1 }) || 'llm_hard_cap'); break;
      }
      // Count a complete scheduler survey, rather than six failures on one gap.
      if (noChangeCycles >= exploratory.maxConsecutiveInvalidSteps) { stop('safety_cap', 'no_state_change'); break; }
      const gap = gaps[0];
      scheduler.surveyTaskIds = [...new Set([...scheduler.surveyTaskIds, gap.id])];
      if (gaps.every((item) => scheduler.surveyTaskIds.includes(item.id))) { noChangeCycles++; scheduler.noChangeCycles = noChangeCycles; scheduler.surveyTaskIds = []; }
      planningTurns.set(gap.id, Math.max(0, ...planningTurns.values()) + 1);
      checkpointState('exploratory-plan-start', { gapId: gap.id });
      const before = budget?.usage.llmTokens || 0;
      let plan;
      try { plan = await planSearchQueries({ ...plannerContext(state, { llm, signal, queryMemory, gate, search, gap }),
        mode: gap.status === 'verified' ? 'challenge' : 'repair', limit: 8,
        hints: [...(gap.slotSupport?.missingFacets || []), ...(state.brief.request?.planningContext?.readingHints || [])],
      }); } catch (error) {
        if (error.name === 'AbortError') { stop('user_cancelled', null); throw error; }
        if (error.name === 'BudgetExceededError' || isExecutionInterruption(error)) throw error;
        plan = { planned: [], queries: [], ok: false, attempts: 1, failure: 'planner_error' };
      }
      state.actionCosts.record('reflect', (budget?.usage.llmTokens || 0) - before);
      recordPlannerMetrics(state, plan, { gapId: gap.id });
      let enqueued = 0;
      for (const planned of plan.planned || []) {
        const accepted = validatePlannedQuery(planned.query, { gap, entities: state.brief.entities || [],
          siteQueryMode: readPolicy.relevance.siteQueryMode, evidenceScope: state.evidenceScope,
          observedHosts: [...state.observedHosts], softScope: true });
        if (!accepted.ok) continue;
        if (scheduler.enqueue({ type: 'search', targetTaskIds: [gap.id], required: Boolean(gap.requiredSlot),
          inputRefs: { query: planned.query, searchOptions: planned.searchOptions }, planned,
          relevance: accepted.relevance, evidenceDependencies: dependencies(state, gap.id), constraintRevision: 1 })) enqueued++;
      }
      if (!enqueued) {
        scheduler.notePlannerFailure(gap.id, dependencies(state, gap.id));
        gap.repairFailures = (gap.repairFailures || 0) + 1;
        if (!scheduler.canPlan(gap.id, dependencies(state, gap.id))) state.markRepairTerminal(gap.id, 'query_planner_exhausted', { phase: 'planner' });
      }
      addTrace(trace, state, 'action_plan', { targetGapIds: [gap.id], queuedActions: enqueued, attempts: plan.attempts }, budget);
      checkpointState('exploratory-step-complete', { action: 'plan', queuedActions: enqueued });
      action = scheduler.next({ canRun });
      if (!action) continue;
    }
    const gapId = action.targetTaskIds[0];
    const gap = state.getGap(gapId);
    const before = stateCounts(state);
    const recovering = recorder?.hasRecoverable?.(null, { actionId: action.actionId });
    scheduler.begin(action);
    recorder?.setActionContext?.(action);
    if (!recovering) state.step += 1;
    state.lastAction = action.type;
    checkpointState('exploratory-action-start', { actionId: action.actionId, attemptId: action.attemptId });
    let outcome;
    try {
      if (action.type === 'search') {
        const result = await performSearch({ action: 'search', gapId, query: action.inputRefs.query,
          plannedQueries: [action.planned], queryOrigin: 'llm_planner', reasonCode: 'queued_search' }, [action.inputRefs.query], gate);
        const error = result.searchResults.find((item) => item.error)?.error;
        outcome = { execution: error ? 'failed' : 'succeeded', retryable: Boolean(error?.retryable), errorCode: error?.code || null,
          returnedCount: result.totalResults, newCandidates: result.newUrls };
      } else if (action.type === 'read_candidate') {
        const result = await performRead({ sourceIds: action.inputRefs.sourceIds, gapId, reasonCode: 'queued_read' });
        outcome = { execution: result.successful ? 'succeeded' : 'failed', transportFailures: result.transportFailures,
          transportSkips: result.transportSkips, successfulReads: result.successful, retryable: false,
          errorCode: result.successful ? null : 'READ_NO_USABLE_BODY',
          failureClass: result.successful ? null : 'source_read' };
      } else {
        const support = await judgeOpenSlotSupport({ llm, signal, query, gaps: [gap], findings: state.findings,
          brief: state.brief, profile: state.profile, evidenceStore: state.evidenceStore, inspectUnseen: true,
          onlyGapIds: [gapId], cache: state.slotSupportCache });
        applySlotSupportJudgments(state.gaps, support.judgments); state.syncGapCoverage();
        outcome = { execution: support.unknown ? 'failed' : 'succeeded', inspected: support.selections.length,
          newSupport: support.judgments.filter((item) => item.verdict === 'supported').length, retryable: false,
          errorCode: support.unknown ? 'SLOT_SUPPORT_UNVALIDATED' : null,
          failureClass: support.unknown ? 'evidence_validation' : null };
      }
    } catch (error) {
      if (error.name === 'AbortError') { scheduler.stop('user_cancelled', null); loopLocal.stopReason = 'user_cancelled'; loopLocal.stopDetail = null; }
      outcome = { execution: error.name === 'AbortError' ? 'interrupted' : 'failed', errorCode: error.code || error.name, retryable: false };
      const receipt = scheduler.receipt(action, outcome);
      checkpointState('exploratory-action-receipt', { receiptId: receipt.receiptId });
      scheduler.apply(receipt);
      checkpointState('exploratory-step-complete', { actionId: action.actionId });
      if (error.name === 'AbortError' || error.name === 'BudgetExceededError' || isExecutionInterruption(error)) throw error;
      continue;
    } finally { recorder?.setActionContext?.(null); }
    outcome.coverageBefore = before; outcome.coverageAfter = stateCounts(state);
    const receipt = scheduler.receipt(action, outcome);
    checkpointState('exploratory-action-receipt', { receiptId: receipt.receiptId });
    scheduler.apply(receipt);
    addTrace(trace, state, 'action_completed', { actionId: action.actionId, type: action.type, targetGapIds: [gapId], ...outcome }, budget);
    checkpointState('exploratory-step-complete', { actionId: action.actionId });
    emit({ stage: 'research_progress', step: state.step, maxSteps: state.maxSteps });
  }
}
