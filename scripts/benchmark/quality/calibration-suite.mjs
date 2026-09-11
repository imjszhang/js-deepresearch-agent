import { RELATION_DECISION_VERSION } from './relation-decision.mjs';
import { BINDING_REVIEW_VERSION } from './assertion-bindings.mjs';
import { calibrationBudgetPlan } from './calibration-budget.mjs';
import { BOUNDARY_STAGE, validateBoundaryFixture, checkBoundaryDiagnostics } from './boundary-diagnostics.mjs';
import { RELATION_REVIEW_VERSION } from './relation-components.mjs';
import { RELATION_AUDIT_VERSION } from './relation-audit.mjs';
import { REQUEST_BUDGET_VERSION } from './request-budget.mjs';
import { LOCATOR_VERSION } from './locators.mjs';
import { EXECUTION_METRICS_VERSION } from './execution-metrics.mjs';
import { validateFrozenVerification } from './calibration-freeze.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { EvidenceStore } from 'js-deepresearch-engine';
import { hash, invariant, readJson, within, span, exactIds, JUDGE_VERSION, EVALUATION_SCHEMA_VERSION, CALIBRATION_SCHEMA_VERSION, SCORING_VERSION } from './schema.mjs';
import { treeHash, publicSettings } from './campaign.mjs';
import { validateOracle, checkOracle } from './calibration-oracle.mjs';

export const CALIBRATION_STAGES = [
  { id: 'development', count: 20, tokens: 180000, wallClockMs: 1800000, requiredMatches: 20, mode: 'assertions' },
  { id: 'assertion_holdout', count: 20, tokens: 150000, wallClockMs: 1500000, requiredMatches: 18, mode: 'assertions' },
  { id: 'scoring_holdout', count: 14, tokens: 210000, wallClockMs: 2100000, requiredMatches: 14, mode: 'score' },
];
export const reportKey = text => hash(text.replace(/\s+/g, '').toLowerCase());
export const DEVELOPMENT_IDS = ['cal-01', 'cal-02', 'cal-03', 'cal-04', 'cal-08', 'cal-10', 'cal-15', 'cal-16', 'cal-17',
  'holdout-27', 'holdout-28', 'holdout-31', 'holdout-39', 'v4-h01', 'v4-h02', 'v4-h03', 'v4-h06', 'v4-h10', 'v4-h13', 'v4-h19'];
export function evaluatorCodeIdentity() {
  return hash({ harness: treeHash('scripts/benchmark/quality'), cli: hash(fs.readFileSync('scripts/benchmark-quality.mjs')),
    runtime: treeHash('packages/js-deepresearch-engine/src'), app: treeHash('src'), lock: hash(fs.readFileSync('package-lock.json')) });
}
export function evaluationModelIdentity(settings) {
  return { ...publicSettings({ provider: settings.llm.provider, model: settings.llm.model, baseUrl: settings.llm.baseUrl }),
    temperature: 0, maxOutputTokens: 4500, reasoningEffort: settings.llm.reasoningEffort || (/qwen/i.test(settings.llm.model || '') ? 'none' : null),
    providerConfigHash: hash(publicSettings({ llm: settings.llm, http: settings.http })) };
}
export function buildCalibrationArtifact(item) {
  const store = new EvidenceStore(), versions = new Map();
  for (const source of item.sources) {
    const v = store.register({ url: source.url, content: source.text, fetchStatus: 'ok' }, 'calibration');
    versions.set(source.id, v);
  }
  const entries = item.citations.map(c => {
    const v = versions.get(c.sourceId);
    invariant(v, 'Unknown calibration citation source');
    return { citationKey: c.key, documentVersionId: v.documentVersionId, sourceId: v.sourceId,
      passageIds: store.chunks(v.documentVersionId).map(p => p.id) };
  });
  const gold = { schemaVersion: 1, topicId: item.family, rubricVersion: 'calibration-2', reviewStatus: 'agent_verified',
    sources: item.sources, criteria: item.criteria, goldHash: hash([item.sources, item.criteria]) };
  const artifact = { report: item.report, reportHash: hash(item.report), pin: { resultRevision: item.id },
    result: { quality: item.execution || {}, evidenceAppendix: item.appendix || '' }, store, registry: { schemaVersion: 1, entries } };
  const caseDefinition = { id: item.id, topicId: item.family, variant: 'open', requirements: [],
    query: item.query || `Investigate ${item.family}.`, scope: item.scope || 'Only the supplied fictional manuals and recorded execution fields establish truth.' };
  return { artifact, gold, caseDefinition };
}
export function loadCalibrationSuite(file) {
  const suite = readJson(file), root = path.dirname(path.resolve(file));
  invariant(suite.schemaVersion === CALIBRATION_SCHEMA_VERSION && suite.judgeVersion === JUDGE_VERSION
    && suite.relationDecisionVersion === RELATION_DECISION_VERSION && suite.bindingReviewVersion === BINDING_REVIEW_VERSION && suite.relationReviewVersion === RELATION_REVIEW_VERSION && suite.relationAuditVersion === RELATION_AUDIT_VERSION && suite.requestBudgetVersion === REQUEST_BUDGET_VERSION
    && suite.locatorVersion === LOCATOR_VERSION && suite.executionMetricsVersion === EXECUTION_METRICS_VERSION
    && suite.evaluationSchemaVersion === EVALUATION_SCHEMA_VERSION && suite.scoringVersion === SCORING_VERSION
    && /^[a-z0-9-]+$/.test(suite.roundId), 'Invalid calibration suite version');
  invariant(suite.totalTokens === 600000 && suite.wallClockMs === 6300000 && suite.timeoutMs === 180000, 'Calibration budget differs from protocol');
  invariant(suite.stages?.length === 3 && suite.exposureRegistry, 'Missing calibration stages or exposure registry');
  const readPinned = ref => {
    const data = readJson(within(root, ref.file));
    invariant(hash(data) === ref.hash, 'Calibration fixture hash mismatch'); return data;
  };
  invariant(suite.boundaryDiagnostics?.count === BOUNDARY_STAGE.count && suite.boundaryDiagnostics?.tokens === BOUNDARY_STAGE.tokens && suite.boundaryDiagnostics?.wallClockMs === BOUNDARY_STAGE.wallClockMs, 'Invalid boundary stage budget');
  const boundaryFixture = readPinned(suite.boundaryDiagnostics.fixture); validateBoundaryFixture(boundaryFixture);
  const registry = readPinned(suite.exposureRegistry);
  invariant(registry.schemaVersion === 1 && registry.entries?.length >= 60, 'Incomplete exposure registry');
  // The mandatory historical corpus cannot be removed by editing the registry.
  const historical = ['calibration.json', 'calibration-holdout-v3.json', 'calibration-holdout-v4.json'].flatMap(name =>
    readJson(path.resolve('tests/fixtures/research-quality', name)).cases);
  invariant(historical.every(c => registry.entries.some(e => e.id === c.id && e.reportHash === reportKey(c.report))), 'Missing historical exposure');
  invariant(DEVELOPMENT_IDS.every(id => registry.entries.some(e => e.id === id && e.roundId === 'quality-v5-round-1' && e.stage === 'development')), 'Missing v5 development exposure');
  const priorV6 = readJson(path.resolve('tests/fixtures/research-quality/v6/development.json')).cases.slice(0, 10);
  invariant(priorV6.every(c => registry.entries.some(e => e.id === c.id && e.reportHash === reportKey(c.report) && e.roundId === 'quality-v6-round-1')), 'Missing v6 development exposure');
  const priorV7 = readJson(path.resolve('tests/fixtures/research-quality/v7/development.json')).cases;
  invariant(priorV7.every(c => registry.entries.some(e => e.id === c.id && e.reportHash === reportKey(c.report) && e.roundId === 'quality-v7-round-1')), 'Missing v7 development exposure');
  const priorDiagnostics = readJson(path.resolve('tests/fixtures/research-quality/v7/relation-boundaries.json')).cases;
  invariant(priorDiagnostics.every(c => registry.diagnosticExposures?.some(e => e.id === c.id && e.roundId === 'quality-v7-round-1' && e.propositionHash === hash(c.proposition) && e.sourceHash === hash(c.sourceText))), 'Missing v7 diagnostic exposure');
  const exposed = new Set(registry.entries.map(e => e.reportHash)), ids = new Set(), reports = new Set();
  const stages = suite.stages.map((stage, index) => {
    const protocol = CALIBRATION_STAGES[index];
    invariant(Object.entries(protocol).every(([key, value]) => stage[key] === value), 'Calibration stage/order/threshold changed');
    const fixture = readPinned(stage.fixture), cases = fixture.cases;
    invariant(cases?.length === stage.count, 'Calibration stage denominator changed');
    if (stage.id === 'development') invariant(hash(cases.map(c => c.id)) === hash(DEVELOPMENT_IDS), 'Fixed development cases/order changed');
    for (const item of cases) {
      invariant(/^[a-z0-9-]+$/.test(item.id) && !ids.has(item.id) && typeof item.report === 'string' && item.report.trim()
        && item.mode === stage.mode && item.family && item.designReview?.length, 'Invalid calibration case');
      const key = reportKey(item.report);
      invariant(!reports.has(key), 'Duplicate calibration report');
      invariant(stage.id === 'development' || !exposed.has(key) && !registry.entries.some(e => e.id === item.id), 'Holdout contains exposed report or ID');
      invariant(stage.id !== 'development' || exposed.has(key), 'Development sample changed');
      ids.add(item.id); reports.add(key);
      invariant(item.sources?.length && item.criteria?.length && Array.isArray(item.citations), 'Missing calibration evidence');
      exactIds(item.sources, [...new Set(item.sources.map(s => s.id))]);
      exactIds(item.criteria, [...new Set(item.criteria.map(c => c.id))]);
      for (const s of item.sources) invariant(s.text?.length && s.version && s.url && s.bodyHash === hash(s.text), 'Invalid calibration body');
      for (const c of item.criteria) {
        invariant(c.expectedAnswer && c.anchors?.length && [1, 2].includes(c.weight) && typeof c.core === 'boolean'
          && typeof c.critical === 'boolean' && Array.isArray(c.qualifiers) && Array.isArray(c.commonErrors), 'Invalid calibration criterion');
        for (const a of c.anchors) {
          const source = item.sources.find(s => s.id === a.sourceId);
          invariant(source && hash(span(source.text, a.span)) === a.textHash, 'Invalid calibration anchor');
        }
      }
      validateOracle(item); buildCalibrationArtifact(item);
    }
    return { ...stage, cases };
  });
  for (const [tag, minimum] of Object.entries({ mixed: 4, unknown_boundary: 4, missing_execution: 2, wrong_citation: 2 })) {
    invariant(stages[1].cases.filter(c => c.tags?.includes(tag)).length >= minimum, `Missing holdout design category: ${tag}`);
  }
  invariant(new Set(stages.slice(1).flatMap(s => s.cases.map(c => c.family))).size >= 2, 'Two new evidence families required');
  invariant(suite.pairs?.length === 7 && new Set(suite.pairs.flatMap(p => [p.a, p.b])).size === 14, 'Seven disjoint scoring pairs required');
  for (const pair of suite.pairs) invariant([pair.a, pair.b].every(id => stages[2].cases.some(c => c.id === id))
    && pair.relations?.length && pair.relations.every(r => r.metric && ['eq', 'gt', 'lt'].includes(r.operator)), 'Invalid scoring pair');
  return { ...suite, stages, registry, boundaryFixture, suiteHash: hash(suite), suiteFile: path.resolve(file) };
}

export function calibrationQualification(summary) {
  const stages = CALIBRATION_STAGES.map(stage => {
    const results = summary.results.filter(r => r.stage === stage.id);
    return { id: stage.id, expected: stage.count, processed: results.length, matched: results.filter(r => r.matched).length,
      passed: results.length === stage.count && results.filter(r => r.matched).length >= stage.requiredMatches
        && results.every(r => r.complete && r.coverageComplete && !r.criticalMiss && !r.boundaryMiss) };
  });
  const usage = summary.usage;
  const usageComplete = Boolean(usage && usage.unknownCalls === 0 && usage.reservedUnknownTokens === 0
    && usage.confirmedTokens <= 600000 && usage.activeMs <= 6300000
    && summary.stageUsage?.relation_diagnostics?.confirmedTokens <= BOUNDARY_STAGE.tokens && summary.stageUsage.relation_diagnostics.activeMs <= BOUNDARY_STAGE.wallClockMs
    && CALIBRATION_STAGES.every(s => summary.stageUsage?.[s.id]?.confirmedTokens <= s.tokens && summary.stageUsage[s.id].activeMs <= s.wallClockMs));
  const factCalibrationPassed = stages[0].passed && stages[1].passed;
  const fullScoringCalibrationPassed = stages[2].passed && summary.pairs?.length === 7 && summary.pairs.every(p => p.matched);
  const boundaryDiagnosticsPassed = summary.boundaryDiagnostics?.passed === true;
  return { stages, usageComplete, factCalibrationPassed, fullScoringCalibrationPassed, boundaryDiagnosticsPassed,
    qualified: factCalibrationPassed && fullScoringCalibrationPassed && usageComplete && boundaryDiagnosticsPassed };
}
export function checkCalibrationPairs(suite, getScore) {
  return suite.pairs.map(pair => {
    const a = getScore(pair.a), b = getScore(pair.b);
    const relations = pair.relations.map(r => {
      const av = a.metrics[r.metric], bv = b.metrics[r.metric];
      return { ...r, a: av, b: bv, matched: r.operator === 'eq' ? av === bv || typeof av === 'number' && typeof bv === 'number' && Math.abs(av - bv) <= 1e-10
        : typeof av === 'number' && typeof bv === 'number' && (r.operator === 'gt' ? av > bv : av < bv) };
    });
    return { id: pair.id, a: pair.a, b: pair.b, relations, matched: relations.every(r => r.matched) };
  });
}
export function requireCalibration(summary, identity = summary?.identity) {
  invariant(summary?.schemaVersion === CALIBRATION_SCHEMA_VERSION && summary.judgeVersion === JUDGE_VERSION
    && summary.scoringVersion === SCORING_VERSION && summary.evaluationSchemaVersion === EVALUATION_SCHEMA_VERSION
    && summary.freezeHash === hash(summary.freeze) && summary.freeze?.codeIdentity === evaluatorCodeIdentity()
    && hash(summary.identity) === hash(identity) && hash(summary.freeze.identity) === hash(identity), 'Calibration gate: incompatible frozen identity');
  invariant(summary.relationDecisionVersion === RELATION_DECISION_VERSION && summary.bindingReviewVersion === BINDING_REVIEW_VERSION && summary.relationReviewVersion === RELATION_REVIEW_VERSION && summary.relationAuditVersion === RELATION_AUDIT_VERSION && summary.requestBudgetVersion === REQUEST_BUDGET_VERSION, 'Calibration gate: incompatible relation protocol');
  invariant(summary.locatorVersion === LOCATOR_VERSION && summary.executionMetricsVersion === EXECUTION_METRICS_VERSION, 'Calibration gate: incompatible locator or metric protocol');
  validateFrozenVerification(summary.freeze);
  const suite = loadCalibrationSuite(summary.freeze.suiteFile);
  invariant(suite.suiteHash === summary.freeze.suiteHash && summary.results?.length === 54
    && new Set(summary.results.map(r => r.id)).size === 54
    && suite.stages.every(s => s.cases.every(c => summary.results.some(r => r.id === c.id && r.stage === s.id))), 'Calibration gate: incomplete frozen suite');
  invariant(hash(summary.freeze.budgetPlan) === hash(calibrationBudgetPlan(suite)), 'Calibration gate: budget plan changed');
  const diagnostics = readJson(path.join(summary.freeze.directory, 'boundary-diagnostics.json'));
  invariant(diagnostics.freezeHash === summary.freezeHash && diagnostics.fixtureHash === hash(suite.boundaryFixture)
    && hash(summary.boundaryDiagnostics) === hash(checkBoundaryDiagnostics(suite.boundaryFixture, diagnostics.results)) && summary.boundaryDiagnostics.passed, 'Calibration gate: boundary diagnostics not passed');
  const scores = new Map();
  for (const stage of suite.stages) for (const item of stage.cases) {
    const score = readJson(path.join(summary.freeze.directory, `${item.id}.json`));
    invariant(score.bindingReviewVersion === BINDING_REVIEW_VERSION && score.bindingComplete === true
      && score.freezeHash === summary.freezeHash && score.caseHash === hash(item)
      && hash(summary.results.find(r => r.id === item.id)) === hash({ ...checkOracle(item, score), stage: stage.id }), 'Calibration gate: case result differs from oracle');
    scores.set(item.id, score);
  }
  invariant(hash(summary.pairs) === hash(checkCalibrationPairs(suite, id => scores.get(id))), 'Calibration gate: scoring pairs differ');
  const qualification = calibrationQualification(summary);
  invariant(summary.status === 'finished' && qualification.qualified && summary.machineCalibrationPassed === true
    && hash(qualification) === hash(summary.qualification), 'Calibration gate: full calibration not passed');
  return qualification;
}
