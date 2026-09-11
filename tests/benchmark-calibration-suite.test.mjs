import { calibrationBudgetPlan } from '../scripts/benchmark/quality/calibration-budget.mjs';
import { freezeVerification, verificationIdentity } from '../scripts/benchmark/quality/calibration-freeze.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSessionLock } from '../src/session-lock.mjs';
import { hash, readJson, writeJson, JUDGE_VERSION, EVALUATION_SCHEMA_VERSION } from '../scripts/benchmark/quality/schema.mjs';
import { RELATION_DECISION_VERSION } from '../scripts/benchmark/quality/relation-decision.mjs';
import { BINDING_REVIEW_VERSION } from '../scripts/benchmark/quality/assertion-bindings.mjs';
import { loadCalibrationSuite, buildCalibrationArtifact, requireCalibration, evaluatorCodeIdentity, checkCalibrationPairs, calibrationQualification } from '../scripts/benchmark/quality/calibration-suite.mjs';
import { calibrate } from '../scripts/benchmark/quality/calibrate.mjs';
import { checkOracle } from '../scripts/benchmark/quality/calibration-oracle.mjs';
import { evaluate } from '../scripts/benchmark/quality/evaluate.mjs';
import { candidateResponse, decisionResponse, basisAuditResponse, bindingResponse } from './helpers/quality-relations.mjs';
import { checkBoundaryDiagnostics, runBoundaryDiagnostics } from '../scripts/benchmark/quality/boundary-diagnostics.mjs';
const source = path.resolve('tests/fixtures/research-quality/v8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-suite-v8-'));
  fs.cpSync(source, path.join(dir, 'fixture'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Upgrade only synthetic temporary protocol metadata. Exposed v8 source
  // files, oracle labels and exposure registries remain historical inputs.
  const file = path.join(dir, 'fixture/suite.json'), suite = readJson(file);
  Object.assign(suite, { judgeVersion: JUDGE_VERSION, evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION });
  const boundaryFile = path.join(dir, 'fixture', suite.boundaryDiagnostics.fixture.file), boundary = readJson(boundaryFile);
  Object.assign(boundary, { relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION });
  writeJson(boundaryFile, boundary); suite.boundaryDiagnostics.fixture.hash = hash(boundary); writeJson(file, suite);
  const planFile = path.resolve('journal/2026-09-11/calibration-round-5-plan.md'), validationFile = path.join(dir, 'validation.json');
  writeJson(validationFile, { codeIdentity: evaluatorCodeIdentity(), verificationIdentity: verificationIdentity(), checks: Object.fromEntries(['test', 'lint', 'build', 'diffCheck'].map(k => [k, { passed: true }])) });
  return { dir, file, planFile, validationFile };
}
function mutate(file, stage, change) {
  const suite = readJson(file), ref = suite.stages[stage].fixture, target = path.join(path.dirname(file), ref.file);
  const data = readJson(target); change(data); writeJson(target, data); ref.hash = hash(data); writeJson(file, suite);
}
function boundaryResponse(fixture, input) {
  if (input.checks.every(c => c.decision)) return basisAuditResponse(input);
  return decisionResponse(input, check => {
    const expected = fixture.cases.find(c => c.id === check.id)?.expected; assert.ok(expected);
    return expected.relation;
  });
}
test('historical v8 cannot load as current protocol; temporary suite preserves 20/20/14 cases and seven pairs', t => {
  assert.throws(() => loadCalibrationSuite(path.join(source, 'suite.json')), /suite version/);
  const suite = loadCalibrationSuite(fixture(t).file);
  assert.deepEqual(suite.stages.map(s => s.cases.length), [20, 20, 14]); assert.equal(suite.registry.entries.length, 110);
  assert.equal(suite.boundaryFixture.cases.length, 24);
  for (const stage of suite.stages) for (const item of stage.cases) {
    const artifact = buildCalibrationArtifact(item);
    assert.ok(!JSON.stringify(artifact).includes('expectedAssertions'));
    assert.ok(!JSON.stringify(artifact).includes('expectedMetrics'));
  }
});
test('v8 preserves formal reports and oracle bytes, while recording report and diagnostic exposure separately', () => {
  for (const name of ['development.json', 'assertion-holdout.json', 'scoring-holdout.json']) assert.deepEqual(
    fs.readFileSync(path.join(source, name)), fs.readFileSync(path.join(source, '../v7', name)));
  const registry = readJson(path.join(source, 'exposure-registry.json'));
  const prior = registry.entries.filter(e => e.roundId === 'quality-v7-round-1');
  assert.equal(prior.length, 20); assert.ok(prior.every(e => e.stage === 'development'));
  const diagnostics = registry.diagnosticExposures;
  assert.equal(diagnostics.filter(e => e.roundId === 'quality-v7-round-1').length, 14);
  assert.equal(diagnostics.filter(e => e.roundId === 'quality-v8-round-1' && e.exposureType === 'fixture_authored').length, 10);
  assert.ok(diagnostics.every(e => !Object.hasOwn(e, 'reportHash')));
  const holdoutIds = new Set(['assertion-holdout.json', 'scoring-holdout.json'].flatMap(name => readJson(path.join(source, name)).cases.map(c => c.id)));
  assert.ok(registry.entries.every(e => !holdoutIds.has(e.id)));
});
test('v8 diagnostic relation oracles preserve all fourteen old meanings and explicitly label presentation scope', () => {
  const fixture = readJson(path.join(source, 'relation-boundaries.json')), old = readJson(path.join(source, '../v7/relation-boundaries.json'));
  assert.equal(fixture.cases.length, 24);
  for (const original of old.cases) {
    const next = fixture.cases.find(c => c.id === original.id);
    for (const key of ['proposition', 'quote', 'sourceText', 'source']) assert.deepEqual(next[key], original[key]);
    assert.deepEqual(next.expected, { relation: original.expected.relation });
    assert.equal(next.expected.auditStatus, undefined);
  }
  assert.equal(fixture.cases.filter(c => Array.isArray(c.initialCandidates) && c.initialCandidates.length === 0).length, 2);
  const presentations = fixture.cases.filter(c => c.presentation); assert.equal(presentations.length, 6);
  for (const c of presentations) {
    assert.match(c.validationScope, /relation_equivalence_only/);
    const p = c.presentation; assert.ok(p.report.slice(...p.assertionSpan).trim());
    assert.ok(p.requiredContextSpans.every(([start, end]) => start >= 0 && end > start && end <= p.report.length));
  }
  for (const group of ['support-presentation', 'absence-presentation']) {
    const cases = presentations.filter(c => c.metamorphicGroup === group); assert.equal(cases.length, 3);
    assert.equal(new Set(cases.map(c => c.proposition)).size, 1);
    assert.equal(new Set(cases.map(c => c.expected.relation)).size, 1);
    assert.equal(new Set(cases.map(c => c.presentation.citationKey)).size, 3);
  }
});
test('all historical rounds, duplicate reports, IDs, changed denominators and unpinned oracle edits are rejected', t => {
  const mutations = [
    (data, suite) => { data.cases[0].report = suite.stages[0].cases[0].report; },
    data => { data.cases[1].report = data.cases[0].report; },
    data => { data.cases[1].id = data.cases[0].id; },
    data => { data.cases.pop(); },
    data => { data.cases[0].id = 'v4-h01'; },
  ];
  for (const change of mutations) {
    const { file } = fixture(t), suite = loadCalibrationSuite(file);
    mutate(file, 1, data => change(data, suite)); assert.throws(() => loadCalibrationSuite(file));
  }
  const { file } = fixture(t), suite = readJson(file), target = path.join(path.dirname(file), suite.stages[1].fixture.file), data = readJson(target);
  data.cases[0].expectedAssertions[0].truth = 'incorrect'; writeJson(target, data);
  assert.throws(() => loadCalibrationSuite(file), /hash mismatch/);
});
test('registry cannot hide the v4 exposure set, and fixed development order cannot be changed', t => {
  const { file } = fixture(t), suite = readJson(file), target = path.join(path.dirname(file), suite.exposureRegistry.file), data = readJson(target);
  data.entries = data.entries.filter(e => !e.id.startsWith('v4-'));
  data.entries.push(...Array.from({ length: 20 }, (_, i) => ({ id: 'fake-' + i, reportHash: hash('fake' + i) })));
  writeJson(target, data); suite.exposureRegistry.hash = hash(data); writeJson(file, suite);
  assert.throws(() => loadCalibrationSuite(file), /historical exposure/);
  const other = fixture(t); mutate(other.file, 0, data => data.cases.reverse());
  assert.throws(() => loadCalibrationSuite(other.file), /Fixed development/);
});
test('v8 requires recorded v7 report and diagnostic exposure, and pins the diagnostic denominator', t => {
  for (const field of ['entries', 'diagnosticExposures']) {
    const { file } = fixture(t), suite = readJson(file), target = path.join(path.dirname(file), suite.exposureRegistry.file), data = readJson(target);
    data[field] = data[field].filter(e => e.roundId !== 'quality-v7-round-1');
    writeJson(target, data); suite.exposureRegistry.hash = hash(data); writeJson(file, suite);
    assert.throws(() => loadCalibrationSuite(file), /v7.*exposure/i);
  }
  const { file } = fixture(t), suite = readJson(file); suite.boundaryDiagnostics.count = 23; writeJson(file, suite);
  assert.throws(() => loadCalibrationSuite(file), /boundary.*(?:count|stage|denominator|budget)/i);
});
test('legacy auditStatus outputs cannot certify current complete relation decisions', t => {
  const suite = loadCalibrationSuite(fixture(t).file);
  const legacy = suite.boundaryFixture.cases.map(c => ({ id: c.id, reviewRelation: c.expected.relation, auditStatus: 'confirmed', checks: {} }));
  assert.equal(checkBoundaryDiagnostics(suite.boundaryFixture, legacy).passed, false);
});
test('development failure stops before any holdout, resume is free, and new directory cannot reset the round', async t => {
  const { dir, file, planFile, validationFile } = fixture(t); let calls = 0;
  const suite = loadCalibrationSuite(file);
  const args = { planFile, validationFile, directory: path.join(dir, 'run'), registryDirectory: path.join(dir, 'registry'), suiteFile: file, identity: { model: 'offline-test' },
    llm: { async completeWithMetadata({ messages }) {
      calls++; const input = JSON.parse(messages[1].content);
      assert.ok(!JSON.stringify(input).includes('expectedAssertions'));
      if (input.checks) return { text: JSON.stringify(boundaryResponse(suite.boundaryFixture, input)), usage: { totalTokens: 1 } };
      return { text: JSON.stringify({ blocks: input.blocks.map(b => b.facts ? { id: b.id, checks: b.units.map(u => ({ id: u.id, status: 'non_assertion', factIds: [] })) }
        : { id: b.id, classification: 'heading', facts: [] }) }), usage: { totalTokens: 1 } };
    } } };
  const summary = await calibrate(args), before = calls;
  assert.equal(summary.stopReason, 'development_gate_failed'); assert.equal(summary.results.length, 20);
  assert.equal(summary.boundaryDiagnostics.passed, true); assert.equal(summary.boundaryDiagnostics.rows.length, 24);
  assert.equal(summary.notExecuted.length, 34); assert.equal(summary.machineCalibrationPassed, false);
  await calibrate(args); assert.equal(calls, before);
  await assert.rejects(calibrate({ ...args, directory: path.join(dir, 'another') }), /already bound/);
  mutate(file, 1, data => { data.cases[0].expectedAssertions[0].truth = 'incorrect'; });
  await assert.rejects(calibrate(args), /inputs changed/); assert.equal(calls, before);
});
test('a completed assertion holdout below its match threshold cannot start expensive scoring', async t => {
  const { dir, file, planFile, validationFile } = fixture(t), suite = loadCalibrationSuite(file);
  const directory = path.join(dir, 'run'); let calls = 0, seeded = false, scoringDispatches = 0;
  // This test exercises stage orchestration with already accepted, frozen score
  // fixtures. It does not claim the mock has independently judged their meaning.
  const args = { planFile, validationFile, directory, registryDirectory: path.join(dir, 'registry'), suiteFile: file, identity: { model: 'offline-stage-gate' },
    llm: { async completeWithMetadata({ messages }) {
      calls++; const input = JSON.parse(messages[1].content);
      if (!seeded) {
        seeded = true; const freezeHash = hash(readJson(path.join(directory, 'freeze.json')));
        for (const [stageIndex, stage] of suite.stages.slice(0, 2).entries()) for (const [itemIndex, item] of stage.cases.entries()) {
          const facts = item.expectedAssertions.map(a => ({ id: a.id, span: a.span, occurrences: [a.span], contextSpans: a.requiredSpans || [], kind: a.kinds[0], citationKeys: a.citations.map(c => c.key) }));
          if (stageIndex === 1 && itemIndex < 3) facts[0].kind = ['fact', 'inference', 'recommendation', 'execution_status'].find(kind => !item.expectedAssertions[0].kinds.includes(kind));
          const score = { freezeHash, caseHash: hash(item), extraction: [], extractionComplete: true, bindingReviewVersion: BINDING_REVIEW_VERSION, bindingComplete: true, facts,
            judgments: { facts: item.expectedAssertions.map(a => ({ id: a.id, truth: a.truth, citations: a.citations })) } };
          assert.equal(checkOracle(item, score).coverageComplete, true);
          assert.equal(checkOracle(item, score).matched, stageIndex === 0 || itemIndex >= 3);
          writeJson(path.join(directory, item.id + '.json'), score);
        }
      }
      if (!input.checks || input.checks.some(c => !suite.boundaryFixture.cases.some(f => f.id === c.id))) { scoringDispatches++; assert.fail('scoring must not dispatch'); }
      return { text: JSON.stringify(boundaryResponse(suite.boundaryFixture, input)), usage: { totalTokens: 1 } };
    } } };
  const summary = await calibrate(args), before = calls;
  assert.equal(summary.status, 'stopped'); assert.equal(summary.stopReason, 'assertion_holdout_gate_failed');
  assert.equal(summary.results.length, 40); assert.equal(summary.results.filter(r => r.stage === 'assertion_holdout' && r.matched).length, 17);
  assert.equal(summary.notExecuted.length, 14); assert.ok(summary.notExecuted.every(r => r.stage === 'scoring_holdout'));
  assert.equal(scoringDispatches, 0); assert.equal(summary.machineCalibrationPassed, false);
  const registry = readJson(path.join(args.registryDirectory, 'registry.json'));
  assert.ok(registry.exposures.every(e => e.stage !== 'scoring_holdout'));
  await calibrate(args); assert.equal(calls, before);
});
test('a budget or unknown-provider pause on the final sample remains resumable instead of becoming finished', async t => {
  for (const pause of ['budget', 'provider']) {
    const { dir, file, planFile, validationFile } = fixture(t), suite = loadCalibrationSuite(file), directory = path.join(dir, 'run');
    const allCases = suite.stages.flatMap(s => s.cases), last = allCases.at(-1);
    let seeded = false, calls = 0, lostInput;
    if (pause === 'budget') {
      // Recorded earlier scoring usage is already at this frozen stage's cap.
      // This is a ledger fixture for orchestration, not a usage estimate.
      writeJson(path.join(directory, 'judge/ledger.json'), { schemaVersion: 1, calls: { 'accepted-scoring-usage': {
        purpose: 'fixture', stage: 'scoring_holdout', reserved: 0, tokens: suite.stages[2].tokens, status: 'responded', activeMs: 1,
        createdAt: new Date().toISOString() } } });
    }
    const lastResponse = input => {
      if (input.blocks) return { blocks: input.blocks.map(b => b.facts ? { id: b.id, checks: b.units.map(u => ({ id: u.id,
        status: b.facts.length ? 'covered' : 'non_assertion', factIds: b.facts.map(f => f.id) })) } : {
        id: b.id, classification: b.text.startsWith('#') ? 'heading' : 'content', facts: b.text.startsWith('#') ? [] : [{
          unitId: b.locator.units[0].id, quote: b.text, proposition: b.text, kind: 'fact', citationKeys: ['1.1'] }] }) };
      if (input.bindings) return bindingResponse(input);
      if (input.checks) return input.materials ? candidateResponse(input) : input.checks[0].decision ? basisAuditResponse(input) : decisionResponse(input);
      assert.ok(input.criteria);
      return { criteria: input.criteria.map(c => ({ id: c.id, answer: 'present', factIds: input.facts.map(f => f.id),
        qualifiers: c.qualifiers.map(q => ({ id: q.id, met: true })), missingMinor: true })) };
    };
    const args = { planFile, validationFile, directory, registryDirectory: path.join(dir, 'registry'), suiteFile: file, identity: { model: 'offline-final-pause-' + pause },
      llm: { async completeWithMetadata({ messages }) {
        calls++; const input = JSON.parse(messages[1].content);
        if (!seeded) {
          seeded = true; const freezeHash = hash(readJson(path.join(directory, 'freeze.json')));
          for (const item of allCases.slice(0, -1)) writeJson(path.join(directory, item.id + '.json'), {
            freezeHash, caseHash: hash(item), extraction: [], extractionComplete: true, bindingReviewVersion: BINDING_REVIEW_VERSION, bindingComplete: true,
            facts: item.expectedAssertions.map(a => ({ id: a.id, span: a.span, occurrences: [a.span], contextSpans: a.requiredSpans || [], kind: a.kinds[0], citationKeys: a.citations.map(c => c.key) })),
            judgments: { facts: item.expectedAssertions.map(a => ({ id: a.id, truth: a.truth, citations: a.citations })) },
            rows: item.expectedCriteria?.map(c => ({ ...c, pending: false })), metrics: { pendingReview: false, ...item.expectedMetrics } });
        }
        if (input.checks?.every(c => suite.boundaryFixture.cases.some(f => f.id === c.id))) return { text: JSON.stringify(boundaryResponse(suite.boundaryFixture, input)), usage: { totalTokens: 1 } };
        assert.equal(pause, 'provider', 'the exhausted budget must reject before dispatch');
        if (!lostInput) { lostInput = input; throw Error('simulated unknown final receipt'); }
        return { text: JSON.stringify(lastResponse(input)), usage: { totalTokens: 1 } };
      } } };
    const first = await calibrate(args);
    assert.equal(first.results.length, 54); assert.equal(first.results.at(-1).id, last.id);
    assert.equal(first.status, 'paused'); assert.equal(first.stopReason, pause === 'budget' ? 'stage_budget_or_provider' : 'unknown_call');
    assert.equal(first.machineCalibrationPassed, false);
    const before = calls;
    if (pause === 'provider') {
      const ledger = readJson(path.join(directory, 'judge/ledger.json'));
      const unknown = Object.entries(ledger.calls).filter(([, call]) => call.tokens == null); assert.equal(unknown.length, 1);
      writeJson(path.join(directory, 'judge', unknown[0][0] + '.json'), { text: JSON.stringify(lastResponse(lostInput)), usage: { totalTokens: 1 }, activeMs: 1 });
    }
    const resumed = await calibrate(args);
    if (pause === 'budget') {
      assert.equal(resumed.status, 'paused'); assert.equal(resumed.stopReason, 'stage_budget_or_provider'); assert.equal(calls, before);
    } else {
      assert.equal(resumed.status, 'finished'); assert.equal(resumed.results.at(-1).matched, true);
      assert.equal(resumed.usage.unknownCalls, 0); assert.equal(resumed.usage.confirmedTokens, resumed.usage.calls);
      const completedCalls = calls; await calibrate(args); assert.equal(calls, completedCalls);
    }
  }
});
test('calibration single-writer lock rejects concurrent mutation before any model call', async t => {
  const { dir, file } = fixture(t), registryDirectory = path.join(dir, 'registry'); fs.mkdirSync(registryDirectory);
  const release = acquireSessionLock(registryDirectory);
  try { await assert.rejects(calibrate({ directory: path.join(dir, 'run'), registryDirectory, suiteFile: file, identity: {}, llm: { completeWithMetadata() { assert.fail(); } } }), /already being written/); }
  finally { release(); }
});

// Offline protocol test: the oracle never enters production inputs. A controlled
// semantic judge supplies relation/check outputs; real semantic accuracy is
// measured separately by the frozen actual-model round.
test('all fourteen reports exercise production extraction, relations, matching and deterministic scoring', async t => {
  const suite = loadCalibrationSuite(fixture(t).file);
  for (const item of suite.stages[2].cases) {
    const phases = [], expectedByProposition = new Map(), firstMaterial = new Map(), expectedRelations = new Map();
    const judge = { identity: {}, usage: () => ({}), async ask(purpose, _, input) {
      phases.push(purpose); assert.equal(input.expectedAssertions, undefined);
      if (purpose === 'extract') return { blocks: input.blocks.map(b => {
        const expected = item.expectedAssertions.filter(a => a.span[0] >= b.start && a.span[1] <= b.start + b.text.length);
        return { id: b.id, classification: b.text.startsWith('#') ? 'heading' : 'content', facts: expected.map(a => {
          expectedByProposition.set(b.text, a);
          return { quote: b.text, unitId: b.locator.units[0].id, proposition: b.text, kind: a.kinds[0], citationKeys: a.citations.map(c => c.key) };
        }) };
      }) };
      if (purpose === 'audit_extraction') return { blocks: input.blocks.map(b => ({ id: b.id,
        checks: b.units.map(u => ({ id: u.id, status: b.facts.length ? 'covered' : 'non_assertion', factIds: b.facts.map(f => f.id) })) })) };
      if (purpose === 'audit_bindings' || purpose === 'audit_bindings_final') return bindingResponse(input);
      if (purpose === 'find_evidence') {
        for (const check of input.checks) {
          const a = expectedByProposition.get(check.proposition); assert.ok(a);
          if (!firstMaterial.has(check.componentId)) firstMaterial.set(check.componentId, check.materialId);
          let relation = null;
          if (firstMaterial.get(check.componentId) === check.materialId) {
            if (check.componentId.startsWith('citation:')) {
              const key = check.componentId.slice(check.componentId.lastIndexOf(':') + 1);
              relation = a.citations.find(c => c.key === key).verdict === 'supported' ? 'full_support' : null;
            } else relation = { correct: 'full_support', incorrect: 'contradiction', unverifiable: null }[a.truth];
          }
          expectedRelations.set(check.id, relation);
        }
        return candidateResponse(input, check => Boolean(expectedRelations.get(check.id)));
      }
      if (purpose === 'decide_relations') return decisionResponse(input, check => {
        assert.ok(expectedRelations.has(check.id)); return expectedRelations.get(check.id);
      });
      if (purpose === 'audit_relation_decisions') return basisAuditResponse(input);
      if (purpose === 'verify_execution') return { reviews: input.reviews.map(f => ({ id: f.id,
        mapping: 'exact', fieldId: 'E-execution.completionStatus', assertedValue: 'incomplete' })) };
      assert.equal(purpose, 'match_criteria');
      return { criteria: input.criteria.map(c => {
        const expected = item.expectedCriteria.find(r => r.id === c.id);
        const matchedFacts = input.facts.filter(f => {
          if (expected.verdict === 'missing') return false;
          // Two-criterion deletion pair has distinct report clauses.
          return c.id === 'retry' ? /retr/i.test(f.proposition) : c.id === 'cancel' ? /cancel/.test(f.proposition) : true;
        });
        return { id: c.id, answer: expected.verdict === 'missing' ? 'absent' : 'present', factIds: matchedFacts.map(f => f.id),
          qualifiers: c.qualifiers.map((q, i) => ({ id: q.id, met: expected.verdict === 'missing' ? false
            : expected.verdict === 'incorrect' && c.id !== 'format' ? i !== 0 : true })),
          missingMinor: c.id === 'format', ...(c.conflictCase ? { conflict: expected.conflict } : {}) };
      }) };
    } };
    const score = await evaluate({ ...buildCalibrationArtifact(item), judge });
    const checked = checkOracle(item, score);
    assert.equal(checked.matched, true, `${item.id}: ${JSON.stringify(checked)}`);
    assert.ok(phases.includes('extract') && phases.includes('audit_extraction'));
    assert.equal(phases.includes('verify_execution'), item.id === 'v5-s05b');
    assert.equal(phases.includes('find_evidence'), item.id !== 'v5-s05b');
    assert.equal(phases.includes('decide_relations'), item.id !== 'v5-s05b');
    assert.equal(phases.includes('audit_relation_decisions'), item.id !== 'v5-s05b');
    assert.equal(phases.includes('audit_bindings'), true);
    assert.equal(phases.includes('match_criteria'), item.id !== 'v5-s05b');
  }
});
test('relabeling old calibration output cannot satisfy schema, input, and full-score gates', () => {
  assert.throws(() => requireCalibration({ schemaVersion: 2, judgeVersion: 'quality-judge-5', machineCalibrationPassed: true }), /Calibration gate/);
});
test('complete certificate validates artifacts and pairs, then rejects identity drift, tampering and unknown usage', async t => {
  const { dir, file, planFile, validationFile } = fixture(t), suite = loadCalibrationSuite(file);
  const identity = { model: 'offline-test' }, freeze = { budgetPlan: calibrationBudgetPlan(suite), ...freezeVerification(planFile, validationFile, evaluatorCodeIdentity()), directory: dir, suiteFile: file, suiteHash: suite.suiteHash, identity, codeIdentity: evaluatorCodeIdentity() };
  const summary = { schemaVersion: 5, judgeVersion: JUDGE_VERSION, locatorVersion: 2, executionMetricsVersion: 1,
    relationReviewVersion: 2, relationAuditVersion: 1, relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION, requestBudgetVersion: 1, scoringVersion: 'quality-scoring-2', evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    freeze, freezeHash: hash(freeze), identity, status: 'finished', results: [], usage: { confirmedTokens: 78, unknownCalls: 0, reservedUnknownTokens: 0, activeMs: 78 },
    stageUsage: { relation_diagnostics: { confirmedTokens: 24, activeMs: 24 } } };
  const diagnostics = await runBoundaryDiagnostics({ fixture: suite.boundaryFixture, freezeHash: summary.freezeHash,
    judge: { async ask(purpose, _, input) { assert.ok(['decide_relations', 'audit_relation_decisions'].includes(purpose)); return boundaryResponse(suite.boundaryFixture, input); } } });
  writeJson(path.join(dir, 'boundary-diagnostics.json'), diagnostics);
  summary.boundaryDiagnostics = checkBoundaryDiagnostics(suite.boundaryFixture, diagnostics.results);
  for (const stage of suite.stages) {
    summary.stageUsage[stage.id] = { confirmedTokens: stage.count, activeMs: stage.count };
    for (const item of stage.cases) {
      const facts = item.expectedAssertions.map(a => ({ id: a.id, span: a.span, occurrences: [a.span], contextSpans: a.requiredSpans, kind: a.kinds[0], citationKeys: a.citations.map(c => c.key) }));
      const score = { freezeHash: summary.freezeHash, caseHash: hash(item), extractionComplete: true, bindingReviewVersion: BINDING_REVIEW_VERSION, bindingComplete: true, facts, judgments: { facts: item.expectedAssertions.map(a => ({ id: a.id, truth: a.truth, citations: a.citations })) },
        rows: item.expectedCriteria?.map(c => ({ ...c, pending: false })), metrics: { pendingReview: false, ...item.expectedMetrics } };
      writeJson(path.join(dir, item.id + '.json'), score); summary.results.push({ ...checkOracle(item, score), stage: stage.id });
    }
  }
  summary.pairs = checkCalibrationPairs(suite, id => readJson(path.join(dir, id + '.json')));
  summary.qualification = calibrationQualification(summary); summary.machineCalibrationPassed = summary.qualification.qualified;
  assert.equal(requireCalibration(summary, identity).qualified, true);
  assert.throws(() => requireCalibration({ ...summary, relationDecisionVersion: 0 }, identity), /relation protocol/);
  assert.throws(() => requireCalibration({ ...summary, bindingReviewVersion: 0 }, identity), /relation protocol/);
  assert.throws(() => requireCalibration(summary, { model: 'changed' }), /identity/);
  summary.usage.unknownCalls = 1; assert.throws(() => requireCalibration(summary), /not passed/); summary.usage.unknownCalls = 0;
  const target = path.join(dir, 'v5-s01a.json'), score = readJson(target);
  score.bindingComplete = false; writeJson(target, score); assert.throws(() => requireCalibration(summary), /binding|case result/i);
  score.bindingComplete = true; delete score.bindingReviewVersion; writeJson(target, score); assert.throws(() => requireCalibration(summary), /binding|case result/i);
  score.bindingReviewVersion = BINDING_REVIEW_VERSION; score.rows[0].evidencePoints = 0; writeJson(target, score);
  assert.throws(() => requireCalibration(summary), /differs from oracle/);
});
