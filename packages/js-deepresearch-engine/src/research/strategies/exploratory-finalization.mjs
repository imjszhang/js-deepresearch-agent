import { fallbackAdaptiveAction, evaluateAnswerReadiness, belowHardCapFrom } from '../adaptive/agent-policy.mjs';
import { mapFinalizeStopReason, resolveNewRunStopReason } from '../adaptive/stop-reasons.mjs';
import { addTrace, dynamicGapCount, STOP_REASONS, FINALIZE_ACTIONS } from './exploratory-planning.mjs';

export function createFinalizationGate({ state, loopLocal, emit, budget, llm, signal, trace, checkpointState, refreshState, canContinueLoop, maxRetries, answerGateEnabled, gateMode, maxOpenGaps }) {
  return async function evaluateFinalization(action, belowMin) {
    const currentGate = refreshState();
    const hasDirectEvidence = state.hasBodyEvidence();
    const continueOk = canContinueLoop();
    if (state.cycle.afterSearch && !state.cycleHasSuccessfulBody() && continueOk) {
      state.observations.push({ type: 'evaluation', verdict: 'needs_body_after_search' });
      state.addDiary('finalize rejected: no successful body in this search-read cycle');
      addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
      checkpointState('exploratory-step-complete', {
        action: 'evaluate-report',
        outcome: 'needs_body_after_search',
      });
      return 'continue';
    }
    if (!hasDirectEvidence && continueOk && state.evaluationRetries < maxRetries && budget?.canClaim('searchRequests')) {
      state.evaluationRetries += 1;
      state.observations.push({ type: 'evaluation', verdict: 'needs_more_evidence' });
      state.addDiary('answer rejected: missing direct evidence');
      addTrace(trace, state, 'evaluate_report', { reasonCode: 'missing_direct_evidence', allowedAdditionalActions: 1 }, budget, 'retry');
      checkpointState('exploratory-step-complete', {
        action: 'evaluate-report',
        outcome: 'needs_more_evidence',
      });
      return 'continue';
    }
    if (!currentGate?.pass && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted && loopLocal.pendingStopReason !== STOP_REASONS.safetyCap) {
      const shouldLlmGate = answerGateEnabled
        && (gateMode === 'llm' || gateMode === 'rules-then-llm')
        && state.evaluationRetries < maxRetries;
      let evaluation = null;
      if (shouldLlmGate) {
        const tokensBefore = budget?.usage?.llmTokens || 0;
        evaluation = await evaluateAnswerReadiness({ llm, state, signal });
        state.actionCosts.record('decide', (budget?.usage?.llmTokens || 0) - tokensBefore);
      }
      if (evaluation?.llmPass && !currentGate.pass) {
        addTrace(trace, state, 'evaluate_report', {
          reasonCode: 'llm_cannot_override_gate',
          missingAspect: evaluation.missingAspect || null,
        }, budget, 'rejected');
      }
      if (continueOk && belowHardCapFrom(state) && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted && loopLocal.pendingStopReason !== STOP_REASONS.safetyCap) {
        state.evaluationRetries += 1;
        state.forbidFinalizeUntilExplore = true;
        if (evaluation?.missingAspect && dynamicGapCount(state) < maxOpenGaps) {
          const gap = state.addGap(evaluation.missingAspect, 'critical');
          if (gap) emit({ stage: 'gap_opened', gapId: gap.id, question: gap.question });
        }
        state.observations.push({
          type: 'evaluation',
          verdict: 'answer_gate_failed',
          missingAspect: evaluation?.missingAspect || currentGate.failures?.[0]?.code || null,
        });
        state.addDiary(`readiness gate failed; keep exploring${evaluation?.missingAspect ? `: ${evaluation.missingAspect.slice(0, 80)}` : ''}`);
        addTrace(trace, state, 'evaluate_report', {
          reasonCode: evaluation?.missingAspect ? 'answer_gate_failed' : (currentGate.failures?.[0]?.code || 'readiness_gate_failed'),
          missingAspect: evaluation?.missingAspect || null,
          failures: currentGate.failures,
        }, budget, 'retry');
        checkpointState('exploratory-step-complete', {
          action: 'evaluate-report',
          outcome: 'readiness_gate_failed',
        });
        return 'continue';
      }
      loopLocal.stopReason = resolveNewRunStopReason(loopLocal.pendingStopReason, {
        step: state.step,
        maxSteps: state.maxSteps,
        budget,
      });
      addTrace(trace, state, 'evaluate_report', {
        reasonCode: 'answer_gate_failed',
        missingAspect: evaluation?.missingAspect || null,
        terminal: true,
        failures: currentGate.failures,
      }, budget, 'failed');
      addTrace(trace, state, 'answer', {
        reasonCode: action.reasonCode || loopLocal.stopReason,
        stopReason: loopLocal.stopReason,
      }, budget);
      return 'stop';
    }
    if (currentGate?.pass && belowMin && continueOk && loopLocal.pendingStopReason !== STOP_REASONS.budgetExhausted) {
      action = fallbackAdaptiveAction(state, { belowMin: true, readiness: currentGate });
      if (!FINALIZE_ACTIONS.has(action.action)) {
        state.addDiary('gate passed but token floor not reached; keep exploring');
        checkpointState('exploratory-step-complete', {
          action: 'evaluate-report',
          outcome: 'token_floor_continue',
        });
        return 'continue';
      }
      if (belowMin) {
        state.addDiary('token floor not reached; refusing evidence_sufficient');
        checkpointState('exploratory-step-complete', {
          action: 'evaluate-report',
          outcome: 'token_floor_refused_finalize',
        });
        return 'continue';
      }
    }
    loopLocal.stopReason = mapFinalizeStopReason(action, loopLocal.pendingStopReason, Boolean(currentGate?.pass) && !belowMin)
      || (currentGate?.pass && !belowMin
        ? STOP_REASONS.evidenceSufficient
        : resolveNewRunStopReason(loopLocal.pendingStopReason, { step: state.step, maxSteps: state.maxSteps, budget }));
    if (loopLocal.stopReason === STOP_REASONS.evidenceSufficient && !currentGate?.pass) {
      loopLocal.stopReason = resolveNewRunStopReason(loopLocal.pendingStopReason, {
        step: state.step,
        maxSteps: state.maxSteps,
        budget,
      });
    }
    addTrace(trace, state, 'answer', { reasonCode: action.reasonCode || 'agent_evidence_sufficient', stopReason: loopLocal.stopReason }, budget);
    return 'stop';
  };
}
