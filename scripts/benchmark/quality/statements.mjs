import { EXECUTION_METRICS, EXECUTION_METRICS_VERSION } from './execution-metrics.mjs';
export const STATEMENT_KINDS = ['fact', 'attribution', 'inference', 'recommendation', 'execution_status', 'research_scope', 'epistemic_limit'];
export const isTechnical = fact => !['recommendation', 'execution_status', 'research_scope', 'epistemic_limit'].includes(fact.kind);
export const isAnswer = fact => !['execution_status', 'research_scope', 'epistemic_limit'].includes(fact.kind);
export const isExecutionStatement = fact => ['execution_status', 'research_scope', 'epistemic_limit'].includes(fact.kind);

export function executionEvidence(artifact, caseDefinition) {
  const q = artifact.result?.quality || {};
  const budget = q.budget || {};
  const groups = [
    { id: 'E-request', value: { query: caseDefinition.query || artifact.result?.brief?.request?.originalQuery || artifact.result?.brief?.query || null } },
    { id: 'E-execution', value: { completionStatus: q.completionStatus ?? null, stopReason: q.stopReason ?? null, stopDetail: q.stopDetail ?? null,
      floorStatus: budget.floorStatus ?? null, confirmedExplorationTokens: budget.usage?.explorationTokens ?? null } },
    { id: 'E-observations', value: { documentVersions: artifact.store?.versions?.size ?? null,
      passages: artifact.store?.passages?.size ?? null, successfulBodyReads: null, sourceReads: budget.usage?.sourceReads ?? null,
      mainReportClaimCount: q.metrics?.mainReportClaimCount ?? null } },
  ];
  return groups.flatMap(group => Object.entries(group.value).map(([field, value]) => ({
    id: `${group.id}.${field}`, field, value, state: budget.unknown?.[field] === true ? 'unknown' : value == null ? 'missing' : 'known',
    definitionVersion: EXECUTION_METRICS_VERSION, ...EXECUTION_METRICS[field],
  })));
}
