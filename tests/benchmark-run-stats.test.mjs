import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRunStats, splitLlmCost } from '../scripts/benchmark/extract-run-stats.mjs';

const artifacts = (budget = {}, trace = []) => ({ meta: {}, quality: { budget }, trace });
const completed = (purpose, tokens) => ({ action: 'llm_call', status: 'completed', purpose, tokens });

test('benchmark costs preserve missing, malformed, and explicit zero separately', () => {
  const missing = extractRunStats(artifacts());
  for (const field of ['llmRequests', 'llmTokens', 'explorationTokens', 'reportTokens', 'evaluationTokens',
    'searchRequests', 'sourceReads', 'rerankRequests', 'rerankTokens', 'estimatedCost']) {
    assert.equal(missing.cost[field], null, field);
  }
  assert.equal(missing.actualLlmTokens, null);
  assert.equal(missing.cost.rerankTokensUnknown, true);
  assert.equal(missing.cost.estimatedCostUnknown, true);

  const zero = extractRunStats(artifacts({ usage: { llmTokens: 0, llmRequests: 0, explorationTokens: 0,
    reportTokens: 0, evaluationTokens: 0, searchRequests: 0, sourceReads: 0, rerankRequests: 0,
    rerankTokens: 0, estimatedCost: 0 } }));
  for (const field of ['llmRequests', 'llmTokens', 'explorationTokens', 'reportTokens', 'evaluationTokens',
    'searchRequests', 'sourceReads', 'rerankRequests', 'rerankTokens', 'estimatedCost']) {
    assert.equal(zero.cost[field], 0, field);
  }
  assert.equal(zero.actualLlmTokens, 0);
  assert.equal(zero.cost.rerankTokensUnknown, false);
  assert.equal(zero.cost.estimatedCostUnknown, false);
  const malformed = extractRunStats(artifacts({ usage: { llmTokens: '0', sourceReads: -1, estimatedCost: false } }));
  assert.equal(malformed.cost.llmTokens, null);
  assert.equal(malformed.cost.sourceReads, null);
  assert.equal(malformed.cost.estimatedCost, null);
});

test('benchmark phase costs never replace a missing phase with zero or overwrite a recorded zero', () => {
  const split = splitLlmCost({ usage: { llmTokens: 90, explorationTokens: 0, evaluationTokens: 90 },
    trace: [completed('agent_decision', 90)] });
  assert.equal(split.explorationTokens, 0);
  assert.equal(split.evaluationTokens, 90);
  assert.equal(split.reportTokens, null);
});

test('benchmark trace classification keeps claim and narrative validation out of exploration', () => {
  const trace = [completed('claim_validation', 100), completed('narrative_validation', 200),
    completed('answer_evaluation', 50), completed('agent_decision', 10), completed('report', 20)];
  const split = splitLlmCost({ usage: { llmRequests: 5, llmTokens: 380 }, trace });
  assert.equal(split.evaluationTokens, 350);
  assert.equal(split.explorationTokens, 10);
  assert.equal(split.reportTokens, 20);
  assert.equal(split.llmTokens, 380);
});

test('benchmark partial traces report observed phase amounts without inventing absent totals or zero phases', () => {
  const split = splitLlmCost({ trace: [completed('claim_validation', 100)] });
  assert.equal(split.evaluationTokens, 100);
  assert.equal(split.explorationTokens, null);
  assert.equal(split.reportTokens, null);
  assert.equal(split.llmTokens, null);
  assert.equal(split.searchRequests, null);
  assert.equal(split.sourceReads, null);
  const unknown = splitLlmCost({ usage: { llmRequests: 1, llmTokens: 100 },
    unknown: { llmTokens: true }, trace: [completed('claim_validation', 100)] });
  assert.equal(unknown.explorationTokens, null);
  assert.equal(unknown.reportTokens, null);
});

test('benchmark trace usage with missing amount or purpose remains unclassified', () => {
  for (const trace of [[completed('report')], [completed('', 10)]]) {
    const split = splitLlmCost({ usage: { llmRequests: 1 }, trace });
    assert.equal(split.explorationTokens, null);
    assert.equal(split.reportTokens, null);
    assert.equal(split.evaluationTokens, null);
  }
});

test('benchmark retains confirmed usage with unknown flags and reservations rather than implying complete cost', () => {
  const stats = extractRunStats(artifacts({ usage: { llmTokens: 0, rerankTokens: 0, estimatedCost: 0 },
    unknown: { llmTokens: true, rerankTokens: true, estimatedCost: true },
    reservations: [{ attemptId: 'unknown-call', amount: 200, status: 'outcome_unknown' }] }));
  assert.equal(stats.cost.llmTokens, 0);
  assert.equal(stats.cost.rerankTokens, 0);
  assert.equal(stats.cost.rerankTokensUnknown, true);
  assert.equal(stats.cost.estimatedCost, null);
  assert.equal(stats.cost.estimatedCostUnknown, true);
  assert.equal(stats.cost.unknownUsage.llmTokens, true);
  assert.equal(stats.cost.costIsLowerBound, true);
});

test('benchmark tail diagnostics subtract only confirmed exploration counters in the same phase', () => {
  const usage = { llmTokens: 1400, explorationTokens: 1000 };
  const trace = [{ action: 'search', resultCount: 1, budgetAfter: { usage: { llmTokens: 1100 } } }];
  assert.equal(extractRunStats(artifacts({ usage }, trace)).zeroEvidenceTailTokens, null);
  trace[0].budgetAfter.usage.explorationTokens = 700;
  assert.equal(extractRunStats(artifacts({ usage }, trace)).zeroEvidenceTailTokens, 300);
  assert.equal(extractRunStats(artifacts({ usage, unknown: { explorationTokens: true } }, trace)).zeroEvidenceTailTokens, null);
  assert.equal(extractRunStats(artifacts({ usage })).zeroEvidenceTailTokens, null);
});
