import { bindingResponse } from './helpers/quality-relations.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EvidenceStore, saveResearchArtifacts, FileRunRecorder } from 'js-deepresearch-engine';
import { aggregateScore } from '../scripts/benchmark/quality/score.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, exactIds, span, validateCase, loadSuite, writeJson, JUDGE_VERSION } from '../scripts/benchmark/quality/schema.mjs';
import { publicSettings, createCampaign, runArguments, runCampaign } from '../scripts/benchmark/quality/campaign.mjs';
import { pinResult, loadResult, citedEvidence } from '../scripts/benchmark/quality/load-result.mjs';
import { reportBlocks, extractReportFacts } from '../scripts/benchmark/quality/report-facts.mjs';
import { compareCampaigns, summarizeCampaign } from '../scripts/benchmark/quality/compare.mjs';
import { summarizeBudget } from '../scripts/benchmark/quality/cost.mjs';
import { evidenceTimeline, diagnosisTiming } from '../scripts/benchmark/quality/timeline.mjs';
import { validateDiagnoses } from '../scripts/benchmark/quality/diagnose.mjs';
import { goldContext } from '../scripts/benchmark/quality/evaluate.mjs';
import { calibrate } from '../scripts/benchmark/quality/calibrate.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-quality-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('production judge responses persist only schema fields, discarding free-form explanations', async t => {
  const dir = temp(t), judge = new Judge({ directory: dir, identity: {}, llm: { async completeWithMetadata() {
    return { text: JSON.stringify({ facts: [], rationale: 'private explanation', arbitraryNotes: 'private explanation' }), usage: { totalTokens: 10 } };
  } } });
  await judge.ask('verify_facts', 'fixture', {}, p => assert.deepEqual(p, { facts: [] }));
  const responses = fs.readdirSync(dir).filter(n => n !== 'ledger.json').map(n => fs.readFileSync(path.join(dir, n), 'utf8'));
  assert.ok(responses.every(text => !text.includes('private explanation')));
});
test('gold evidence IDs identify exact anchors, independently of criterion IDs', () => {
  const context = goldContext({ sources: [{ id: 'source', text: 'abcdef' }], criteria: [{ id: 'criterion', anchors: [
    { sourceId: 'source', span: [0, 2] }, { sourceId: 'source', span: [3, 6] },
  ] }] });
  assert.equal(context[0].id, undefined);
  assert.equal(context[0].criterionId, 'criterion');
  assert.deepEqual(context[0].evidence.map(e => [e.id, e.text]), [['G1', 'ab'], ['G2', 'def']]);
});
test('legacy calibration entry cannot bypass the full suite contract', async t => {
  const dir = temp(t), fixture = JSON.parse(fs.readFileSync('tests/fixtures/research-quality/calibration.json'));
  const holdoutFile = path.join(dir, 'holdout.json');
  writeJson(holdoutFile, { judgeVersion: JUDGE_VERSION, cases: Array.from({ length: 20 }, (_, i) => ({
    id: 'new-' + i, split: 'holdout', report: 'Uncalled cache validation fixture ' + i, expectedTruth: 'unverifiable',
  })) });
  writeJson(path.join(dir, `${fixture.cases[0].id}.json`), { calibrationIdentity: { judgeVersion: 'old' } });
  await assert.rejects(calibrate({ directory: dir, identity: {}, holdoutFile, llm: { completeWithMetadata() { throw Error('must not call'); } } }), /versioned suite/);
});
test('multiple diagnosis stages require body and claim observations individually', () => {
  const failures = ['adjudication_error', 'render_semantic_error'].map(stage => ({ stage, contextIds: ['body'], claimIds: ['claim'], confidence: 'medium' }));
  const value = { diagnoses: [{ id: 'criterion', failures }] };
  validateDiagnoses(value, 'criterion', [{ id: 'body' }], [{ claimId: 'claim' }]);
  failures[1].claimIds = [];
  assert.throws(() => validateDiagnoses(value, 'criterion', [{ id: 'body' }], [{ claimId: 'claim' }]), /without claim/);
});
test('timeline preserves first checkpoint observations without inferring correctness', t => {
  const dir = temp(t), recorder = new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: 'fixture' });
  const budget = { usage: { llmTokens: 10, explorationTokens: 10 }, unknown: {} };
  recorder.checkpoint('exploratory-step-complete', { budget, candidates: [['url', { url: 'https://example.test/', id: 's1' }]] });
  recorder.checkpoint('exploratory-step-complete', { budget: { ...budget, usage: { llmTokens: 20, explorationTokens: 20 } },
    evidenceStore: { versions: [{ documentVersionId: 'v1', sourceId: 's1', url: 'https://example.test/' }], passages: [{ id: 'p1', documentVersionId: 'v1' }] } });
  recorder.checkpoint('canonical-claims-validated', { budget, claimRecords: [{ claimId: 'c1', evaluation: { verdict: 'supported' } }], bindings: [{ taskId: 'g1', claimId: 'c1' }] });
  const timeline = evidenceTimeline(dir);
  assert.equal(timeline.firstCandidate['https://example.test/'].confirmedTokens, 10);
  assert.equal(timeline.firstBody.v1.confirmedTokens, 20);
  const timing = diagnosisTiming({ contexts: [{ documentVersionId: 'v1', url: 'https://example.test/' }], claimIds: ['c1'] }, timeline);
  assert.equal(timing.firstIndependentCorrectJudgment, null);
  assert.equal(timing.firstClaimRecords[0].point.boundary, 'canonical-claims-validated');
  recorder.checkpoint('research-complete', { result: { resultRevision: 'r1', quality: { budget } } });
  recorder.checkpoint('exploratory-step-complete', { candidates: [['later', { url: 'https://later.test/' }]] });
  assert.equal(evidenceTimeline(dir, 'r1').firstCandidate['https://later.test/'], undefined);
  assert.throws(() => evidenceTimeline(dir, 'missing'), /unavailable/);
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints', 'latest.json')));
  fs.writeFileSync(path.join(dir, latest.state.path), '{}');
  assert.throws(() => evidenceTimeline(dir), /hash mismatch/);
});
function scoring() {
  const gold = { criteria: ['a', 'b'].map(id => ({ id, weight: 2, core: true, critical: true, requirementIds: ['req'] })) };
  const facts = ['a', 'b'].map(id => ({ id, citationKeys: ['1.1'] }));
  const judgments = { criteria: ['a', 'b'].map(id => ({ id, verdict: 'correct', factIds: [id], conflict: 'not_applicable' })),
    facts: ['a', 'b'].map(id => ({ id, truth: 'correct', majorError: false, citations: [{ key: '1.1', verdict: 'supported' }] })) };
  return { gold, facts, judgments, requirements: [{ id: 'req' }] };
}
test('controlled correct judgments reach model thresholds but are not human reviewed', () => {
  const s = aggregateScore(scoring()); assert.equal(s.metrics.correctCoverage, 1); assert.equal(s.modelThresholdsMet, true); assert.equal(s.reviewStatus, 'machine_draft');
});
test('deleting half the answer reduces coverage even with perfect citations', () => {
  const x = scoring(); x.facts.pop(); x.judgments.facts.pop(); Object.assign(x.judgments.criteria[1], { verdict: 'missing', factIds: [] });
  const s = aggregateScore(x); assert.equal(s.metrics.correctCoverage, 0.5); assert.equal(s.metrics.citationSupportRate, 1); assert.equal(s.modelThresholdsMet, false);
});
test('adding an unverifiable uncited assertion reduces strict fact accuracy', () => {
  const x = scoring(); x.facts.push({ id: 'extra', citationKeys: [] }); x.judgments.facts.push({ id: 'extra', truth: 'unverifiable', citations: [], majorError: false });
  const s = aggregateScore(x); assert.equal(s.metrics.strictFactAccuracy, 2 / 3); assert.equal(s.metrics.uncitedFactRate, 1 / 3);
});
test('empty report has zero coverage and N/A accuracy, never passes', () => {
  const x = scoring(); x.facts = []; x.judgments.facts = []; x.judgments.criteria.forEach(c => Object.assign(c, { verdict: 'missing', factIds: [] }));
  const s = aggregateScore(x); assert.equal(s.metrics.correctCoverage, 0); assert.equal(s.metrics.strictFactAccuracy, null); assert.equal(s.metrics.citationSupportRate, null); assert.equal(s.modelThresholdsMet, false);
});
test('wrong version/decisive condition overrides an optimistic criterion matcher', () => {
  const x = scoring(); x.judgments.facts[0].truth = 'incorrect'; x.judgments.facts[0].majorError = true;
  const s = aggregateScore(x); assert.equal(s.metrics.correctCoverage, 0.5); assert.equal(s.metrics.majorErrorCount, 1);
});
test('judge cannot downgrade the severity of an incorrect predefined critical criterion', () => {
  const x = scoring(); x.judgments.facts[0].truth = 'incorrect'; x.judgments.facts[0].majorError = false;
  assert.equal(aggregateScore(x).metrics.majorErrorCount, 1);
});
test('correct fact with unsupported citation earns no evidence coverage', () => {
  const x = scoring(); x.judgments.facts[0].citations[0].verdict = 'unsupported';
  const s = aggregateScore(x); assert.equal(s.metrics.correctCoverage, 1); assert.equal(s.metrics.evidenceCoverage, 0.5);
});
test('unresolved citation cannot provide supported evidence', () => {
  const x = scoring(); x.judgments.facts.forEach(f => f.citations[0].verdict = 'unresolved'); assert.equal(aggregateScore(x).metrics.evidenceCoverage, 0);
});
test('pending evaluator verdict produces bounds and no final pass', () => {
  const x = scoring(); x.judgments.facts[0].truth = 'pending_review'; const s = aggregateScore(x);
  assert.equal(s.metrics.correctCoverage, 0.5); assert.equal(s.metrics.coverageUpperBound, 1); assert.equal(s.reviewStatus, 'pending_review');
});
test('undiscussed conflicts remain unresolved', () => {
  const x = scoring(); x.gold.criteria[0].conflictCase = 'historical versus current'; x.judgments.criteria[0].conflict = 'missing';
  assert.equal(aggregateScore(x).metrics.conflictResolutionRate, 0); assert.equal(aggregateScore(x).modelThresholdsMet, false);
});
test('resolved version distinction is accepted without treating all differing texts as false', () => {
  const x = scoring(); x.gold.criteria[0].conflictCase = 'historical versus current'; x.judgments.criteria[0].conflict = 'resolved';
  assert.equal(aggregateScore(x).metrics.conflictResolutionRate, 1);
});
test('partial credit must be declared before seeing an answer', () => {
  const x = scoring(); x.judgments.criteria[0].verdict = 'partial'; assert.throws(() => aggregateScore(x), /predefined/);
  x.gold.criteria[0].partialCredit = 'noncritical example omitted'; assert.equal(aggregateScore(x).metrics.correctCoverage, 0.75);
});
test('duplicate, extra and missing criterion judgments are structural errors', () => {
  for (const kind of ['duplicate', 'extra', 'missing']) {
    const x = scoring(); if (kind === 'duplicate') x.judgments.criteria[1] = x.judgments.criteria[0];
    if (kind === 'extra') x.judgments.criteria.push({ id: 'extra' }); if (kind === 'missing') x.judgments.criteria.pop();
    assert.throws(() => aggregateScore(x), /exact/);
  }
});
test('duplicate and missing fact judgments fail closed', () => { const x = scoring(); x.judgments.facts[1] = x.judgments.facts[0]; assert.throws(() => aggregateScore(x), /exact/); });
test('repeated mapping cannot inflate criterion score', () => { const x = scoring(); x.judgments.criteria[0].factIds = ['a', 'a']; assert.throws(() => aggregateScore(x), /coverage/); });
test('appendix-only facts cannot satisfy main report criterion IDs', () => { const x = scoring(); x.judgments.criteria[0].factIds = ['appendix-only']; assert.throws(() => aggregateScore(x), /coverage/); });
test('open question reports exploration coverage without inventing explicit requirements', () => { const x = scoring(); x.variant = 'open'; assert.equal(aggregateScore(x).metrics.explicitRequirementCompletion, null); });
test('UTF-16 spans retain surrogate-pair offsets and reject out of range', () => { assert.equal(span('a😀b', [1, 3]), '😀'); assert.throws(() => span('a', [0, 2])); });
test('public cases reject answers and fabricated open requirements', () => {
  const c = { id: 'x', topicId: 'x', variant: 'open', query: 'question', requirements: [] }; validateCase(c);
  assert.throws(() => validateCase({ ...c, expectedAnswer: 'hidden' }));
  assert.throws(() => validateCase({ ...c, requirements: [{ id: 'x', text: 'question', span: [0, 8] }] }));
});
test('configuration fingerprint redacts credentials and preserves actual token budgets', () => {
  const s = publicSettings({ apiKey: 'secret', baseUrl: 'https://name:password@site.test/v1?key=hidden', maxTokens: 100, nested: { password: 'hidden' } });
  assert.equal(s.apiKey, '[redacted]'); assert.equal(s.baseUrl, 'https://site.test/v1'); assert.equal(s.maxTokens, 100); assert.ok(!JSON.stringify(s).includes('hidden'));
});
test('suite has four original queries, deterministic eight-run schedule, and no gold args', t => {
  const suite = loadSuite('benchmarks/research-quality/v1/suite.json'), dir = temp(t);
  const a = createCampaign({ suite, directory: path.join(dir, 'a'), identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  const b = createCampaign({ suite, directory: path.join(dir, 'b'), identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  assert.equal(a.runs.length, 8); assert.deepEqual(a.runs.map(r => r.id), b.runs.map(r => r.id));
  const args = runArguments(a.runs[0], a.protocol, '/eyes'); assert.equal(args[0], 'exec'); assert.ok(args.includes(a.runs[0].case.query)); assert.ok(args.includes('--no-save')); assert.ok(!args.join(' ').includes('gold'));
});
test('environment failure pauses batch and remains in denominator', async t => {
  const dir = temp(t), suite = loadSuite('benchmarks/research-quality/v1/suite.json');
  createCampaign({ suite, directory: dir, identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  let calls = 0;
  const c = await runCampaign({ file: path.join(dir, 'campaign.json'), currentIdentity: {}, execute: async () => { calls++; return { code: 1 }; } });
  assert.equal(calls, 1); assert.equal(c.runs[0].status, 'research_failed'); assert.equal(summarizeCampaign(c, dir).deliverySuccessRate, 0);
});
test('changed frozen configuration prevents external runs', async t => {
  const dir = temp(t), suite = loadSuite('benchmarks/research-quality/v1/suite.json');
  createCampaign({ suite, directory: dir, identity: {}, cliPath: '/eyes', skillDir: '/skill' });
  await assert.rejects(runCampaign({ file: path.join(dir, 'campaign.json'), currentIdentity: { model: 'changed' }, execute: () => assert.fail() }), /changed/);
});
test('judge caches a response and settles token consumption only once', async t => {
  const directory = temp(t); let calls = 0; const llm = { completeWithMetadata: async () => { calls++; return { text: '{"ok":true}', usage: { totalTokens: 30 } }; } };
  const j = new Judge({ llm, directory, identity: { model: 'test' } });
  const check = p => assert.equal(p.ok, true); await j.ask('test', 'return JSON', {}, check); await j.ask('test', 'return JSON', {}, check);
  assert.equal(calls, 1); assert.equal(j.usage().confirmedTokens, 30);
  const reopened = new Judge({ llm, directory, identity: { model: 'test' } }); await reopened.ask('test', 'return JSON', {}, check); assert.equal(calls, 1);
});
test('unknown response usage retains reservation on cache recovery', async t => {
  const j = new Judge({ llm: { completeWithMetadata: async () => ({ text: '{}' }) }, directory: temp(t), identity: {} });
  await j.ask('x', '', {}, () => {}); const u = j.usage(); assert.equal(u.unknownCalls, 1); assert.ok(u.reservedUnknownTokens > 0);
  await j.ask('x', '', {}, () => {}); assert.deepEqual(j.usage(), u);
});
test('ambiguous provider failure cannot be silently retried or charged zero', async t => {
  let calls = 0; const j = new Judge({ llm: { completeWithMetadata: async () => { calls++; throw Error('secret'); } }, directory: temp(t), identity: {} });
  await assert.rejects(j.ask('x', '', {}, () => {}), /JUDGE_PROVIDER_FAILED/);
  await assert.rejects(j.ask('x', '', {}, () => {}), /OUTCOME_UNKNOWN/); assert.equal(calls, 1); assert.equal(j.usage().unknownCalls, 1);
});
test('judge budget prevents a call before reservation overspend', async t => {
  const j = new Judge({ llm: { completeWithMetadata: () => assert.fail() }, directory: temp(t), identity: {}, limit: 1 });
  await assert.rejects(j.ask('x', '', {}, () => {}), /BUDGET/); assert.equal(j.usage().calls, 0);
});
test('invalid judge IDs get bounded retry and then explicit structural failure', async t => {
  let calls = 0; const j = new Judge({ llm: { completeWithMetadata: async () => { calls++; return { text: '{"items":[{"id":"a"},{"id":"a"}]}', usage: { totalTokens: 5 } }; } }, directory: temp(t), identity: {} });
  await assert.rejects(j.ask('x', '', {}, p => exactIds(p.items, ['a', 'b'])), /STRUCTURE_INVALID/); assert.equal(calls, 2); assert.equal(j.usage().confirmedTokens, 10);
});
function artifactFixture(t) {
  const dir = temp(t), store = new EvidenceStore();
  const v = store.register({ url: 'https://example.test', content: 'In version one, the fictional database permits one active writer at a time.', fetchStatus: 'ok' }, 'task');
  const p = store.chunks(v.documentVersionId)[0];
  const result = { resultRevision: 'one', report: '# Report\n\nOne writer [1.1].', findings: [], sources: [], evidenceStore: store.export(),
    citationRegistry: { schemaVersion: 1, entries: [{ citationKey: '1.1', sourceId: v.sourceId, documentVersionId: v.documentVersionId, passageIds: [p.id], url: v.url }] }, evidenceAppendix: '# Evidence' };
  const a = saveResearchArtifacts({ sessionDir: dir, query: 'test', strategy: 'focused', settings: {}, result });
  return { dir, v, a, result };
}
test('pinned result ignores later current pointers and legacy root copies', t => {
  const { dir, result } = artifactFixture(t), pin = pinResult(dir);
  saveResearchArtifacts({ sessionDir: dir, query: 'test', strategy: 'focused', settings: {}, result: { ...result, resultRevision: 'two', report: '# Changed' } });
  fs.writeFileSync(path.join(dir, 'report.md'), '# stale'); assert.match(loadResult(pin).report, /One writer/); assert.equal(citedEvidence(loadResult(pin))[0].resolved, true);
});
test('corrupt evidence fails without borrowing legacy findings', t => {
  const { dir, a, v } = artifactFixture(t), pin = pinResult(dir); fs.writeFileSync(path.join(a.resultDir, v.bodyRef), 'corrupt'); assert.throws(() => loadResult(pin), /integrity/);
});
test('changed manifest hash and result revision fail closed', t => {
  const { dir } = artifactFixture(t), pin = pinResult(dir); assert.throws(() => loadResult({ ...pin, manifestHash: hash('wrong') }), /Pinned/);
  assert.throws(() => loadResult({ ...pin, resultRevision: 'wrong' }), /Pinned/);
});
test('full report extraction includes uncited table/summary and checks every block', async () => {
  const report = '# Title\n\nA is one.\n\n| B | two |';
  const judge = { ask: async (purpose, instruction, input, validate) => {
    if (purpose === 'audit_bindings') { const result = bindingResponse(input); validate(result); return result; }
    const result = purpose === 'audit_extraction' ? { blocks: input.blocks.map(b => ({ id: b.id,
      checks: b.units.map(u => ({ id: u.id, status: b.facts.length ? 'covered' : 'non_assertion', factIds: b.facts.map(f => f.id) })) })) }
      : { blocks: input.blocks.map(b => ({ id: b.id, classification: b.text.startsWith('#') ? 'heading' : 'content', facts: b.text.startsWith('#') ? [] : [{ quote: b.text, unitId: b.locator.units[0].id, proposition: b.text, kind: 'fact', citationKeys: [] }] })) };
    validate(result); return result;
  } };
  const result = await extractReportFacts(report, judge); assert.equal(result.extraction.length, reportBlocks(report).length); assert.equal(result.facts.length, 2); assert.deepEqual(result.facts[1].citationKeys, []);
  assert.equal(result.extractionComplete, true);
});
test('comparison flags protocol drift', () => {
  const a = { id: 'a', protocolVersion: 'one', suiteHash: 'x', protocol: {}, identity: {} }; assert.equal(compareCampaigns(a, { ...a, protocolVersion: 'two' }).comparable, false);
});
test('cached score must match the exact campaign result revision', t => {
  const dir = temp(t); writeJson(path.join(dir, 'r', 'score.json'), { resultPin: { resultRevision: 'other', manifestHash: 'h' } });
  assert.throws(() => summarizeCampaign({ id: 'x', runs: [{ id: 'r', case: { id: 'x' }, pin: { resultRevision: 'one', manifestHash: 'h' } }] }, dir), /revision/);
});
test('total-fuse campaign rejects unbounded report output before starting any run', t => {
  const suite = loadSuite('benchmarks/research-quality/v1/suite.json'); suite.protocol.reportMaxOutputTokens = 0;
  assert.throws(() => createCampaign({ suite, directory: temp(t), identity: {}, cliPath: '/eyes', skillDir: '/skill' }), /bounded report/);
});
test('budget rollup retains unknown consumption and deduplicates reservations/settlements', () => {
  const cost = summarizeBudget({ usage: { llmTokens: 80, explorationTokens: 60 }, unknown: { llmTokens: true, estimatedCost: true }, floorStatus: 'unknown',
    reservations: [{ attemptId: 'a', amount: 20, status: 'outcome_unknown' }, { attemptId: 'a', amount: 20, status: 'outcome_unknown' }], settledAttemptIds: ['x', 'x'] }, 2);
  assert.equal(cost.confirmedTokens, 80); assert.equal(cost.reservedTokens, 20); assert.equal(cost.settledAttempts, 1);
  assert.equal(cost.costIsLowerBound, true); assert.equal(cost.costPerSupportedCriterion, 40); assert.equal(cost.estimatedCost, null); assert.equal(cost.reportTokens, null);
});
