import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCalibrationSuite } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { calibrationBudgetPlan } from '../scripts/benchmark/quality/calibration-budget.mjs';
import { hash, readJson, writeJson, JUDGE_VERSION, EVALUATION_SCHEMA_VERSION } from '../scripts/benchmark/quality/schema.mjs';
import { RELATION_DECISION_VERSION } from '../scripts/benchmark/quality/relation-decision.mjs';
import { BINDING_REVIEW_VERSION } from '../scripts/benchmark/quality/assertion-bindings.mjs';
const suiteFile = 'tests/fixtures/research-quality/v8/suite.json';
function currentSuite(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-budget-current-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.dirname(suiteFile), directory, { recursive: true });
  const file = path.join(directory, 'suite.json'), suite = readJson(file);
  // Only the synthetic copy's protocol metadata changes; the historical case
  // bodies, oracle meanings, budgets and exposure records stay untouched.
  Object.assign(suite, { judgeVersion: JUDGE_VERSION, evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION });
  const boundaryFile = path.join(directory, suite.boundaryDiagnostics.fixture.file), boundary = readJson(boundaryFile);
  Object.assign(boundary, { relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION });
  writeJson(boundaryFile, boundary); suite.boundaryDiagnostics.fixture.hash = hash(boundary); writeJson(file, suite);
  return loadCalibrationSuite(file);
}
test('budget plan includes the full fixed suite and distinguishes safe reservations from predicted usage', t => {
  assert.throws(() => loadCalibrationSuite(suiteFile), /suite version/);
  const suite = currentSuite(t), plan = calibrationBudgetPlan(suite);
  assert.deepEqual(plan.stages.map(s => s.cases), [20, 20, 14]);
  assert.deepEqual(plan.stages.map(s => s.cap), [180000, 150000, 210000]);
  assert.equal(plan.boundaryStage.count, 24); assert.equal(plan.boundaryStage.tokens, 60000); assert.equal(plan.totalCap, 600000);
  assert.equal(plan.knownRequestsAdmissible, true); assert.equal(plan.wholeRunUsageGuaranteed, false);
  assert.equal(plan.dynamicUsage, 'unknown_until_responses');
  assert.ok(plan.stages.every(s => s.extraction.maximumDispatches === s.extraction.requestCount * 2));
  for (const stage of plan.stages) for (const phase of ['audit_bindings', 'repair_bindings_if_missing', 'find_evidence', 'decide_relations',
    'audit_relation_decisions', 'repair_relation_decisions_if_invalid', 'audit_relation_decisions_final']) assert.ok(stage.dynamicStages.includes(phase));
});
test('an oversized known atomic owner fails admission planning without dropping it', t => {
  const suite = currentSuite(t); suite.stages[0].cases[0].report = 'x'.repeat(250000);
  const plan = calibrationBudgetPlan(suite);
  assert.equal(plan.knownRequestsAdmissible, false); assert.equal(plan.stages[0].cases, 20);
  assert.ok(plan.stages[0].extraction.largestReservation > plan.stages[0].cap);
});
