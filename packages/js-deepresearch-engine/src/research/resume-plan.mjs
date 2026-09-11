import { loadNamedCheckpoint } from './run-recorder.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BudgetManager } from './budget-manager.mjs';

export const REPORT_RESUME_MODES = Object.freeze([
  'commit-result',
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
  const reason = checkpoint?.state?.scheduler?.terminal?.reason || local.stopReason || checkpoint?.state?.budget?.controllerStopReason;
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
  const continuation = loadNamedCheckpoint(sessionDir, 'exploratory-continuation-start');
  const stepComplete = newest(loadNamedCheckpoint(sessionDir, 'exploratory-step-complete'), continuation,
    loadNamedCheckpoint(sessionDir, 'exploratory-action-start'), loadNamedCheckpoint(sessionDir, 'exploratory-action-receipt'),
    loadNamedCheckpoint(sessionDir, 'exploratory-plan-start'), loadNamedCheckpoint(sessionDir, 'legacy-state-migrated'));
  const ledger = loadNamedCheckpoint(sessionDir, 'budget-ledger');
  const start = loadNamedCheckpoint(sessionDir, 'research-start');
  const healthLedger = loadNamedCheckpoint(sessionDir, 'search-health');
  const latestLedger = newest(ledger, healthLedger);
  for (const entry of [pre, strategyComplete, loopComplete, stepComplete, start]) {
    if (!entry?.state || entry.state.budget?.executionVersion !== 2) continue;
    const latestBudget = latestLedger && newest(entry, latestLedger) === latestLedger ? latestLedger.state.budget : entry.state.budget;
    const budget = new BudgetManager({}).restoreCheckpoint(latestBudget);
    for (const reservation of [...budget.reservations.values()]) {
      if (!/^llm-\d+$/.test(reservation.attemptId)) throw new Error('Invalid budget attempt ID');
      const file = path.join(sessionDir, 'calls', `${reservation.attemptId}.response.json`);
      const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (receipt && (receipt.callId !== reservation.attemptId || receipt.kind !== 'llm')) throw new Error('Budget receipt mismatch');
      budget.settleAttempt(reservation.attemptId, receipt?.response?.usage);
    }
    entry.state.budget = budget.exportCheckpoint();
  }
  const complete = loadNamedCheckpoint(sessionDir, 'research-complete');

  if (continueExplore) {
    const steps = Number(extraSteps);
    if (!Number.isFinite(steps) || steps < 1) {
      throw new Error('Flag --continue-explore requires --resume-extra-steps <n> with n >= 1.');
    }
    const checkpoint = newest(loopComplete, stepComplete);
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

  // An old final result must never take precedence over newer exploration.
  const finalResult = complete && finalResultFromCheckpoint(complete, sessionDir);
  const latest = newest(pre, strategyComplete, loopComplete, stepComplete, finalResult ? complete : null);
  if (finalResult && latest === complete) {
    return { mode: 'commit-result', checkpoint: complete };
  }

  if (pre?.state && latest === pre) {
    return { mode: 'report', checkpoint: pre };
  }

  if (strategyComplete?.state && latest === strategyComplete) {
    return { mode: 'report-from-strategy', checkpoint: strategyComplete };
  }

  if (loopComplete?.state && latest === loopComplete) {
    return { mode: 'finalize-loop', checkpoint: loopComplete };
  }

  if (stepComplete?.state && checkpointHasTerminalLoopStop(stepComplete)) {
    return { mode: 'finalize-loop', checkpoint: stepComplete };
  }

  if (stepComplete?.state) {
    return { mode: 'mid-loop', checkpoint: stepComplete };
  }

  if (start?.state) return { mode: 'start', checkpoint: start };

  throw new Error(
    'Session has no pre-report, strategy-complete, exploratory-loop-complete, '
    + 'or unfinished exploratory-step-complete checkpoint. '
    + 'To explore further after a finished loop, pass --continue-explore --resume-extra-steps <n>.',
  );
}

function newest(...entries) {
  return entries.filter(Boolean).sort((a, b) => Number(b.checkpoint?.checkpointId || b.checkpointId || 0)
    - Number(a.checkpoint?.checkpointId || a.checkpointId || 0))[0] || null;
}

export function finalResultFromCheckpoint(checkpoint, sessionDir = '') {
  const state = checkpoint?.state;
  const result = state?.result || (state && Object.fromEntries([
    'report', 'reportPlan', 'reportContract', 'brief', 'findings', 'sources', 'gaps', 'passages', 'claims', 'quality', 'trace',
  ].map((key) => [key, state[key]])));
  if (!result || typeof result.report !== 'string' || !result.report.trim()
    || !Array.isArray(result.sources) || !Array.isArray(result.findings) || !result.quality) return null;
  return {
    ...result,
    resultRevision: result.resultRevision || `recovered-${crypto.createHash('sha256')
      .update(JSON.stringify([sessionDir, checkpoint.checkpoint?.checkpointId || checkpoint.checkpointId, result]))
      .digest('hex')}`,
  };
}
