import { hash } from './schema.mjs';
import { reportExtractionRequests } from './report-facts.mjs';
import { evaluatorMessages, requestPlanEnvelope, REQUEST_BUDGET_VERSION } from './request-budget.mjs';
import { BOUNDARY_STAGE } from './boundary-diagnostics.mjs';

// A reservation is a safe dispatch ceiling, not predicted usage. Later facts,
// quotes and audits depend on model output, so expose that uncertainty instead
// of promising a whole-run token estimate from the first request alone.
export function calibrationBudgetPlan(suite) {
  const stages = suite.stages.map(stage => {
    const requests = stage.cases.flatMap(item => reportExtractionRequests(item.report).map((r, i) => ({ id: `${item.id}:extract:${i}`,
      stage: stage.id, messages: evaluatorMessages(r.instructions, r.input), maxOutputTokens: r.maxOutputTokens, maxAttempts: 2 })));
    const envelope = requestPlanEnvelope(requests);
    const sourceOccurrences = stage.cases.flatMap(c => c.sources);
    const bodyBytes = sourceOccurrences.reduce((n, s) => n + Buffer.byteLength(s.text, 'utf8'), 0);
    return { id: stage.id, cases: stage.count, cap: stage.tokens, wallClockMs: stage.wallClockMs, extraction: envelope,
      sourceBytesAcrossCases: bodyBytes, distinctBodies: new Set(sourceOccurrences.map(s => hash(s.text))).size,
      remainingReserveAfterLargestKnownRequest: stage.tokens - envelope.largestReservation,
      knownRequestsAdmissible: envelope.largestReservation <= stage.tokens,
      dynamicStages: ['audit_extraction', 'extract_repair_if_missing', 'audit_bindings', 'repair_bindings_if_missing', 'audit_bindings_final', 'find_evidence', 'decide_relations', 'audit_relation_decisions', 'repair_relation_decisions_if_invalid', 'audit_relation_decisions_final', 'verify_execution', ...(stage.mode === 'score' ? ['match_criteria'] : [])] };
  });
  return { requestBudgetVersion: REQUEST_BUDGET_VERSION, suiteHash: suite.suiteHash, totalCap: suite.totalTokens,
    boundaryStage: BOUNDARY_STAGE, stages, knownRequestsAdmissible: stages.every(s => s.knownRequestsAdmissible),
    wholeRunUsageGuaranteed: false, dynamicUsage: 'unknown_until_responses',
    policy: 'No usage estimate replaces conservative per-dispatch reservations. Stages cannot borrow. Persist unknown reservations. Report every unexecuted sample.' };
}
