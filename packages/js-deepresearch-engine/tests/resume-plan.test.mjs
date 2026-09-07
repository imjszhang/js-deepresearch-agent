import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { FileRunRecorder, selectResearchResumePlan } from '../src/index.mjs';

describe('research resume plan', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSession() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-resume-plan-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'exploratory', '2026-09-07_051000');
    return { sessionDir, recorder: new FileRunRecorder({
      sessionDir,
      runId: 'resume-plan',
      strategy: 'exploratory',
      query: 'qwen hardware',
    }) };
  }

  it('prefers report-only when pre-report exists and continue-explore is off', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-step-complete', { query: 'qwen hardware', step: 2 });
    recorder.checkpoint('exploratory-loop-complete', { query: 'qwen hardware', step: 4 });
    recorder.checkpoint('pre-report', { query: 'qwen hardware', strategy: 'exploratory' });
    const plan = selectResearchResumePlan({ sessionDir });
    assert.equal(plan.mode, 'report');
  });

  it('resumes an unfinished exploratory step', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-step-complete', { query: 'qwen hardware', step: 2 });
    const plan = selectResearchResumePlan({ sessionDir });
    assert.equal(plan.mode, 'mid-loop');
    assert.equal(plan.checkpoint.state.step, 2);
  });

  it('finalizes a finished loop without pre-report instead of refusing', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-loop-complete', {
      query: 'qwen hardware',
      step: 9,
      loopLocal: { stopReason: 'safety_cap', stopDetail: 'query_planner_exhausted' },
    });
    const plan = selectResearchResumePlan({ sessionDir });
    assert.equal(plan.mode, 'finalize-loop');
  });

  it('writes the report from strategy-complete when pre-report is missing', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-loop-complete', { query: 'qwen hardware', step: 9 });
    recorder.checkpoint('strategy-complete', {
      query: 'qwen hardware',
      strategy: 'exploratory',
      findings: [],
    });
    const plan = selectResearchResumePlan({ sessionDir });
    assert.equal(plan.mode, 'report-from-strategy');
  });

  it('does not treat a terminal step checkpoint as mid-loop', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-step-complete', {
      query: 'qwen hardware',
      step: 6,
      loopLocal: { stopReason: 'safety_cap', stopDetail: 'query_planner_exhausted' },
    });
    const plan = selectResearchResumePlan({ sessionDir });
    assert.equal(plan.mode, 'finalize-loop');
  });

  it('requires extra steps to continue after a finished loop', () => {
    const { sessionDir, recorder } = makeSession();
    recorder.checkpoint('exploratory-loop-complete', { query: 'qwen hardware', step: 9 });
    recorder.checkpoint('pre-report', { query: 'qwen hardware' });
    assert.throws(
      () => selectResearchResumePlan({ sessionDir, continueExplore: true }),
      /--resume-extra-steps/,
    );
    const plan = selectResearchResumePlan({
      sessionDir,
      continueExplore: true,
      extraSteps: 3,
    });
    assert.equal(plan.mode, 'continue-explore');
    assert.equal(plan.extraSteps, 3);
    assert.equal(plan.checkpoint.state.step, 9);
  });
});
