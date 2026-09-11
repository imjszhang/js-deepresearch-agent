import { operationalTruth } from './evidence-relations.mjs';
import { modelAssessment } from './verification-contract.mjs';

export const EXECUTION_METRICS_VERSION = 1;
export const EXECUTION_METRICS = {
  sourceReads: { unit: 'logical_read', object: 'logical attempts charged to the reading budget, including failed reads; not successful reads or HTTP retries', source: 'quality.budget.usage.sourceReads' },
  successfulBodyReads: { unit: 'successful_body_read', object: 'successful source body read operations across the complete run, deduplicated across retries and recovery; not document versions', source: 'unavailable: historical artifacts have no certified complete-run counter' },
  documentVersions: { unit: 'body_version', object: 'distinct stored body versions, not read operations', source: 'validated EvidenceStore.versions.size' },
  passages: { unit: 'passage', object: 'stored evidence passages', source: 'validated EvidenceStore.passages.size' },
  confirmedExplorationTokens: { unit: 'token', object: 'confirmed exploration token usage only', source: 'quality.budget.usage.explorationTokens' },
  floorStatus: { unit: 'status', object: 'whether the confirmed exploration token floor was met', source: 'quality.budget.floorStatus', allowedValues: ['met', 'unmet', 'unknown'] },
  completionStatus: { unit: 'status', object: 'completion of research requirements', source: 'quality.completionStatus', allowedValues: ['complete', 'incomplete'] },
  query: { unit: 'text', object: 'original research question', source: 'case query or saved request' },
  stopReason: { unit: 'status', object: 'recorded research stop reason', source: 'quality.stopReason' },
  stopDetail: { unit: 'status', object: 'recorded detailed stop reason', source: 'quality.stopDetail' },
  mainReportClaimCount: { unit: 'claim', object: 'claims in main report', source: 'quality.metrics.mainReportClaimCount' },
};

export function assessExecutionMapping(check, fields, source) {
  const truth = operationalTruth(check, fields);
  const field = fields.find(f => f.id === check.fieldId);
  return { ...modelAssessment({ ...check, truth }, source),
    comparison: { origin: 'program_check', scope: 'recorded_value_given_model_selected_field',
      fieldId: field?.id || null, state: field?.state || 'unavailable',
      equal: check.mapping === 'exact' && field?.state === 'known' ? field.value === check.assertedValue : null } };
}

export function recordedExecutionObservations(fields) {
  return fields.map(field => ({ ...field, origin: 'program_check', observationScope: 'recorded_field_value' }));
}
