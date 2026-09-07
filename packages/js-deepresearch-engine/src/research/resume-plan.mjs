import { loadNamedCheckpoint } from './run-recorder.mjs';

export const REPORT_RESUME_MODES = Object.freeze([
  'report',
  'report-from-strategy',
  'finalize-loop',
]);

const TERMINAL_LOOP_STOPS = new Set([
  'evidence_sufficient',
  'budget_exhausted',
  'safety_cap',
  'user_cancelled',
  'contract_unavailable',
]);

export function isReportResumeMode(mode) {
  return REPORT_RESUME_MODES.includes(mode);
}

export function checkpointHasTerminalLoopStop(checkpoint) {
  const local = checkpoint?.state?.loopLocal || {};
  const reason = local.stopReason || checkpoint?.state?.budget?.controllerStopReason;
  return TERMINAL_LOOP_STOPS.has(reason);
}

export function selectResearchResumePlan({
  sessionDir,
  continueExplore = false,
  extraSteps = 0,
} = {}) {
  const pre = loadNamedCheckpoint(sessionDir, 'pre-report');
  const strategyComplete = loadNamedCheckpoint(sessionDir, 'strategy-complete');
  const loopComplete = loadNamedCheckpoint(sessionDir, 'exploratory-loop-complete');
  const stepComplete = loadNamedCheckpoint(sessionDir, 'exploratory-step-complete');

  if (continueExplore) {
    const steps = Number(extraSteps);
    if (!Number.isFinite(steps) || steps < 1) {
      throw new Error('Flag --continue-explore requires --resume-extra-steps <n> with n >= 1.');
    }
    const checkpoint = loopComplete || stepComplete;
    if (!checkpoint?.state) {
      throw new Error(
        'Cannot continue explore: session has no exploratory-loop-complete or exploratory-step-complete checkpoint.',
      );
    }
    return {
      mode: 'continue-explore',
      checkpoint,
      extraSteps: steps,
    };
  }

  if (pre?.state) {
    return { mode: 'report', checkpoint: pre };
  }

  if (strategyComplete?.state) {
    return { mode: 'report-from-strategy', checkpoint: strategyComplete };
  }

  if (loopComplete?.state) {
    return { mode: 'finalize-loop', checkpoint: loopComplete };
  }

  if (stepComplete?.state && checkpointHasTerminalLoopStop(stepComplete)) {
    return { mode: 'finalize-loop', checkpoint: stepComplete };
  }

  if (stepComplete?.state) {
    return { mode: 'mid-loop', checkpoint: stepComplete };
  }

  throw new Error(
    'Session has no pre-report, strategy-complete, exploratory-loop-complete, '
    + 'or unfinished exploratory-step-complete checkpoint. '
    + 'To explore further after a finished loop, pass --continue-explore --resume-extra-steps <n>.',
  );
}
