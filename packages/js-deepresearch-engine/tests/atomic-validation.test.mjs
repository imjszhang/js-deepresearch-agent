import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EvidenceStore } from '../src/research/evidence-store.mjs';
import { normalizeClaimCandidates } from '../src/research/claim-candidates.mjs';
import { buildClaimGraph, deliverableBinding } from '../src/research/claim-graph.mjs';
import { validateResearchClaims } from '../src/research/claim-validation.mjs';
import { finalizeCanonicalReport } from '../src/research/canonical-report.mjs';
import { createResearchRequest, applyRequestContract } from '../src/research/research-request.mjs';
import { researchBriefFromInput } from '../src/research/research-brief.mjs';
import { BudgetManager } from '../src/research/budget-manager.mjs';
import { recorderOrNoop } from '../src/research/run-recorder.mjs';

test('three required tasks with only two verified answers deliver two findings and remain incomplete', async () => {
 const { store, p, gaps } = fixture();
 const supported = gaps[0].slotSupport.claimCandidates[0];
 const local = normalizeClaimCandidates([{ proposition: 'Atlas version 1 supports local files.', kind: 'source_attributed',
   conditions: ['version 1'], quote: 'Atlas version 1 supports local files.', supportingPassageIds: [p.id] }], [p])[0];
 const tasks = [
   { ...gaps[0], id: 'license', question: 'Atlas license', status: 'verified', slotSupport: { ...gaps[0].slotSupport,
     verdict: 'supported', missingFacets: [], claimCandidates: [supported] } },
   { ...gaps[0], id: 'files', question: 'Atlas local files', status: 'verified', slotSupport: { ...gaps[0].slotSupport,
     verdict: 'supported', missingFacets: [], claimCandidates: [local] } },
   { id: 'memory', question: 'Atlas memory requirements', requiredSlot: true, status: 'open' },
 ];
 const result = await finalizeCanonicalReport({ llm: checker(), emit() {}, recorder: recorderOrNoop(),
   budget: new BudgetManager({ research: { report: { maxOutputTokens: 16000 } } }), strategy: 'exploratory',
   query: 'Atlas license, files and memory', resolvedBrief: { executionVersion: 2, constraints: [], requiredAnswerSlots: tasks },
   findings: [], gaps: tasks, passageArtifacts: { evidenceStore: store.export(), passages: [...store.passages.values()], sources: [] },
   reportSettings: { minChars: 10, maxOutputTokens: 16000 }, trace: [], stopReason: 'safety_cap', readiness: { pass: false } });
 assert.equal(result.quality.metrics.mainReportClaimCount, 2);
 assert.equal(result.quality.metrics.requiredTaskCount, 3);
 assert.equal(result.quality.metrics.verifiedRequiredTaskCount, 2);
 assert.notEqual(result.quality.completionStatus, 'complete');
 assert.ok(result.reportPlan.narrativePlan.limitations.some(l => l.taskId === 'memory'));
});

function fixture() {
 const store = new EvidenceStore();
 const version = store.register({ url: 'https://atlas.test/manual', content: 'Atlas version 1 uses license MIT. Atlas version 1 supports local files.', fetchStatus: 'ok' }, 'g1');
 const p = store.chunks(version.documentVersionId)[0];
 const candidates = normalizeClaimCandidates([
  { proposition: 'Atlas version 1 uses license MIT.', kind: 'source_attributed', conditions: ['version 1'], quote: 'Atlas version 1 uses license MIT.', supportingPassageIds: [p.id] },
  { proposition: 'Atlas version 1 uses 100 GiB of memory.', kind: 'source_attributed', conditions: ['version 1'], quote: 'Atlas version 1 supports local files.', supportingPassageIds: [p.id] }
 ], [p]);
 const gaps = [{ id: 'g1', question: 'Atlas license and memory', taskType: 'fact', status: 'body_read', requiredSlot: true,
 slotSupport: { quoteAnchored: true, verdict: 'partially_supported', quote: p.text, answer: 'composite', supportingPassageIds: [p.id],
 missingFacets: ['memory'], claimCandidates: candidates } }];
 return { store, p, gaps };
}
function checker(onCall = () => {}) {
 return { async complete({ purpose, messages }) {
  onCall(purpose);
  const input = JSON.parse(messages.find(m => m.role === 'user').content);
  if (purpose === 'claim_validation') return JSON.stringify({ judgments: input.claims.map(c => ({
   claimId: c.claimId, atomic: true, verdict: c.proposition.includes('100 GiB') ? 'unverifiable' : 'supported', counterPassageIds: [],
   bindings: c.tasks.map(t => ({ taskId: t.taskId, answerRelation: 'supported' })) })) });
  if (purpose === 'report') return JSON.stringify({ summary: 'Some conclusions are verified, but required memory evidence remains unresolved.',
   renderings: input.claims.map(c => ({ claimId: c.claimId, text: c.proposition })),
   limitations: input.limitations.map(l => ({ taskId: l.taskId, text: 'Evidence for ' + l.question + ' remains incomplete.' })) });
  if (purpose === 'narrative_validation') return JSON.stringify({ sameLanguage: true, summaryFaithful: true, limitationsFaithful: true,
   judgments: input.claims.map(c => ({ claimId: c.claimId, faithful: true })) });
  assert.fail(purpose);
 } };
}
test('equivalent candidates with different quotes produce one binding and a valid report', async () => {
 const { store, p, gaps } = fixture();
 const candidate = gaps[0].slotSupport.claimCandidates[0];
 const duplicate = normalizeClaimCandidates([{ ...candidate, quote: p.text }], [p])[0];
 assert.notEqual(candidate.candidateId, duplicate.candidateId);
 gaps[0].status = 'verified';
 gaps[0].slotSupport = { ...gaps[0].slotSupport, verdict: 'supported', missingFacets: [], claimCandidates: [candidate, duplicate] };
 const graph = buildClaimGraph({ gaps, passages: [p] });
 assert.equal(graph.records.length, 1); assert.equal(graph.bindings.length, 1);
 let validations = 0;
 const result = await finalizeCanonicalReport({ llm: checker(purpose => { if (purpose === 'claim_validation') validations++; }),
   emit() {}, recorder: recorderOrNoop(), budget: new BudgetManager({ research: { report: { maxOutputTokens: 16000 } } }),
   strategy: 'exploratory', query: 'Atlas license', resolvedBrief: { executionVersion: 2, constraints: [], requiredAnswerSlots: gaps },
   findings: [], gaps, passageArtifacts: { evidenceStore: store.export(), passages: [p], sources: [] },
   reportSettings: { minChars: 10, maxOutputTokens: 16000 }, trace: [], stopReason: 'safety_cap', readiness: { pass: false } });
 assert.equal(validations, 1);
 assert.equal(result.reportPlan.bindings.length, 1);
 assert.equal(result.quality.metrics.mainReportClaimCount, 1);
 assert.match(result.report, /Atlas version 1 uses license MIT/);
});

test('deduplication keeps separate tasks and unions counter-evidence on a shared claim', async () => {
 const { store, p, gaps } = fixture();
 const candidate = gaps[0].slotSupport.claimCandidates[0];
 const counter = store.register({ url: 'https://atlas.test/correction', content: 'Atlas version 1 does not use MIT.', fetchStatus: 'ok' }, 'g1');
 const c = store.chunks(counter.documentVersionId)[0];
 const tasks = ['license', 'redistribution'].map((id, index) => ({ ...gaps[0], id,
   slotSupport: { ...gaps[0].slotSupport, claimCandidates: [candidate], contradictingPassageIds: index ? [] : [c.id] } }));
 const graph = buildClaimGraph({ gaps: tasks, passages: [p, c] });
 assert.equal(graph.records.length, 1);
 assert.deepEqual(graph.bindings.map(b => b.taskId), ['license', 'redistribution']);
 assert.deepEqual(graph.records[0].counterRefs.map(r => r.passageId), [c.id]);
 await validateResearchClaims({ graph, store, gaps: tasks, query: 'Atlas license', llm: { async complete({ messages }) {
   const input = JSON.parse(messages[1].content);
   assert.equal(input.claims[0].tasks.length, 2);
   return JSON.stringify({ judgments: input.claims.map(claim => ({ claimId: claim.claimId, atomic: true,
     verdict: 'conflicting', counterPassageIds: [], bindings: claim.tasks.map(task => ({ taskId: task.taskId, answerRelation: 'supported' })) })) });
 } } });
 assert.equal(graph.bindings.filter(deliverableBinding).length, 0);
});
test('both explicit benchmark queries retain every request through tasks or unresolved constraints', () => {
 for (const id of ['redis-explicit', 'sqlite-explicit']) {
  const c = JSON.parse(fs.readFileSync(new URL('../../../benchmarks/research-quality/v1/cases/' + id + '.json', import.meta.url)));
  const request = createResearchRequest(c.query);
  const profile = applyRequestContract({ brief: {} }, { ...researchBriefFromInput(c.query), request });
  const covered = [...request.inputTasks.flatMap(t => t.basisRanges), ...profile.brief.constraints.filter(c => c.validationStatus === 'unresolved')
   .map(c => [c.basisRef.startChar, c.basisRef.endChar])];
  for (const req of c.requirements) {
   for (let i = req.span[0]; i < req.span[1]; i++) {
    if (/\s|[，、,]/.test(c.query[i])) continue;
    assert.ok(covered.some(([a, b]) => i >= a && i < b), id + ':' + req.id + ':' + i);
   }
  }
 }
 for (const id of ['redis-open', 'sqlite-open']) {
  const c = JSON.parse(fs.readFileSync(new URL('../../../benchmarks/research-quality/v1/cases/' + id + '.json', import.meta.url)));
  assert.equal(createResearchRequest(c.query).inputTasks.length, 0);
 }
});
test('generic instructions preserve shared conditions, negations and structured obligations', () => {
 const query = '针对 Nova 2.1，在离线条件下使用。分别列出部署方式，解释禁用同步后的行为。不要推断联网性能。';
 const request = createResearchRequest({ query, requiredAnswerSlots: [{ id: 'extra', question: '故障恢复' }] });
 const profile = applyRequestContract({ brief: {} }, { ...researchBriefFromInput({ query, requiredAnswerSlots: [{ id: 'extra', question: '故障恢复' }] }), request });
 assert.equal(profile.brief.requiredAnswerSlots.filter(t => t.requiredSlot).length, 3);
 assert.ok(request.inputTasks.every(t => t.sharedContext.includes('Nova 2.1') && t.sharedContext.includes('离线')));
 assert.ok(profile.brief.constraints.some(c => c.validationStatus === 'unresolved' && c.value.includes('不要')));
 const english = createResearchRequest('For Nova v2 under offline conditions:\n1. Explain storage requirements\n2. Compare recovery methods');
 assert.equal(english.inputTasks.length, 2);
 assert.ok(english.inputTasks.every(t => t.sharedContext.includes('offline')));
});
test('literal quotes do not certify candidates; an unsupported half cannot be delivered', async () => {
 const { store, gaps } = fixture(), graph = buildClaimGraph({ gaps, passages: [...store.passages.values()] });
 await validateResearchClaims({ graph, store, gaps, query: 'Atlas license and memory', llm: checker() });
 assert.equal(graph.records.length, 2);
 assert.equal(graph.bindings.filter(deliverableBinding).length, 1);
 assert.equal(graph.bindings.every(b => b.adequacy === 'verified'), false);
 assert.throws(() => normalizeClaimCandidates([{ proposition: 'invented', kind: 'source_attributed', conditions: [], quote: 'invented', supportingPassageIds: ['missing'] }], []), /Unanchored/);
});
test('[V22] partial task renders its verified atomic conclusion and keeps the unresolved facet', async () => {
 const { store, gaps } = fixture();
 const budget = new BudgetManager({ research: { report: { maxOutputTokens: 16000 } } });
 const result = await finalizeCanonicalReport({ llm: checker(), emit() {}, recorder: recorderOrNoop(), budget,
 strategy: 'exploratory', query: 'Atlas license and memory', resolvedBrief: { executionVersion: 2, constraints: [], requiredAnswerSlots: gaps },
 findings: [], gaps, passageArtifacts: { evidenceStore: store.export(), passages: [...store.passages.values()], sources: [] },
 reportSettings: { minChars: 10, maxOutputTokens: 16000 }, trace: [], stopReason: 'safety_cap', stopDetail: 'fixture', readiness: { pass: false } });
 assert.match(result.report, /Atlas version 1 uses license MIT/);
 assert.doesNotMatch(result.report, /100 GiB/);
 assert.equal(result.quality.gate, 'fail');
 assert.notEqual(result.quality.completionStatus, 'complete');
 assert.equal(result.quality.metrics.mainReportClaimCount, 1);
 assert.equal(result.reportPlan.narrativePlan.limitations.filter(l => l.taskId === 'g1').length, 1);
});
test('unchanged dependencies and irrelevant bodies cause zero new semantic validations', async () => {
 const { store, gaps } = fixture(); let calls = 0;
 const llm = checker(() => calls++), cache = {};
 const run = () => validateResearchClaims({ graph: buildClaimGraph({ gaps, passages: [...store.passages.values()] }), store, gaps,
 query: 'Atlas license and memory', llm, cache });
 await run(); assert.equal(calls, 1);
 await run(); assert.equal(calls, 1);
 const unrelated = store.register({ url: 'https://weather.test/', content: 'Rainfall near forests remains seasonal.', fetchStatus: 'ok' }, 'other');
 store.chunks(unrelated.documentVersionId);
 await run(); assert.equal(calls, 1);
 gaps[0].question = 'Atlas version 2 license and memory';
 await run(); assert.equal(calls, 2);
 await validateResearchClaims({ graph: buildClaimGraph({ gaps, passages: [...store.passages.values()] }), store, gaps,
 query: 'Atlas license and memory', llm, cache, validationProtocolVersion: 999 });
 assert.equal(calls, 3);
});
test('[V22] new related counter-evidence invalidates cached judgments and cannot coexist with supported', async () => {
 const { store, gaps } = fixture(); const cache = {};
 await validateResearchClaims({ graph: buildClaimGraph({ gaps, passages: [...store.passages.values()] }), store, gaps, query: 'Atlas license', llm: checker(), cache });
 const other = store.register({ url: 'https://atlas.test/correction', content: 'Atlas version 1 does not use license MIT; the previous license statement is wrong.', fetchStatus: 'ok' }, 'g1');
 const counter = store.chunks(other.documentVersionId)[0];
 const graph = buildClaimGraph({ gaps, passages: [...store.passages.values()] });
 await validateResearchClaims({ graph, store, gaps, query: 'Atlas license', cache, llm: { async complete({ messages }) {
  const input = JSON.parse(messages[1].content);
  assert.ok(input.claims.every(c => c.comparisonPassages.some(p => p.id === counter.id)));
  return JSON.stringify({ judgments: input.claims.map(c => ({ claimId: c.claimId, atomic: true, verdict: 'supported',
   counterPassageIds: [counter.id], bindings: c.tasks.map(t => ({ taskId: t.taskId, answerRelation: 'supported' })) })) });
 } } });
 assert.ok(graph.records.every(c => c.evaluation.verdict === 'conflicting' && c.counterRefs.some(r => r.passageId === counter.id)));
 assert.equal(graph.bindings.filter(deliverableBinding).length, 0);
});
