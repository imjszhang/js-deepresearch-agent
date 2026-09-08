import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchRunner, EvidenceStore, buildCitationMap, parseCitations } from '../src/index.mjs';
import { canonicalLlm, body } from './helpers/canonical-llm.mjs';

export const settings = { llm: {}, search: {}, research: { strategy: 'exploratory',
  exploratory: { maxSteps: 8, minLlmTokens: 0, maxLlmTokens: 100000, autoReadTopK: 0 },
  focused: { fetchMode: 'disabled', evidencePassages: { embedding: { enabled: false } } } } };
const search = { async search() { return [{ title: 'Atlas documentation', url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok', contentOrigin: 'provided' }]; } };

test('new exploration queues actions, freezes request and renders stable cited claims', async () => {
  const calls = [];
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm: canonicalLlm({ onCall: (args) => calls.push(args.purpose) }) });
  assert.equal(result.executionVersion, 2);
  assert.equal(result.brief.request.originalQuery, '调研 Atlas 这个产品');
  assert.equal(result.brief.requiredAnswerSlots.filter((slot) => slot.requiredSlot).length, 1);
  assert.ok(!calls.includes('agent_decision'));
  assert.ok(!calls.includes('claim_extraction'));
  assert.ok(calls.includes('claim_validation'));
  assert.ok(result.claims.length);
  assert.equal(result.quality.budget.floorStatus, 'met');
  assert.equal(result.quality.gate, 'pass');
  assert.ok(!result.quality.readiness.failures.some((item) => item.code === 'contract_slot_missing'));
  const store = new EvidenceStore(result.evidenceStore);
  const map = buildCitationMap([], { citationRegistry: result.citationRegistry, evidenceStore: store });
  assert.ok(parseCitations(result.report).every((key) => map.has(key)));
  assert.ok(result.claims.every((claim) => claim.passageIds.every((id) => store.passages.has(id))));
  assert.ok(result.report.length < 3000);
  assert.ok(!result.report.includes(body));
});

test('report conflicts downgrade the required binding and cannot resurrect verified evidence', async () => {
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm: canonicalLlm({ conflict: true }) });
  assert.equal(result.quality.gate, 'fail');
  assert.equal(result.quality.readiness.pass, false);
  assert.ok(result.reportPlan.bindings.filter((item) => item.required).every((item) => item.adequacy !== 'verified'));
  assert.ok(!result.report.includes('以 MIT 许可证分发'));
  assert.ok(result.report.includes('缺少足够证据'));
  assert.equal(result.quality.metrics.uniqueCitationCount, 0);
  assert.equal(result.quality.metrics.citationRegistryEntryCount, result.citationRegistry.entries.length);
});

for (const purpose of ['claim_validation', 'narrative_validation']) {
  test(`${purpose} rejects duplicate judgments instead of selecting the first verdict`, async () => {
    const good = canonicalLlm();
    let attempts = 0;
    const llm = { async completeWithMetadata(args) {
      const response = await good.completeWithMetadata(args);
      if (args.purpose === purpose) {
        attempts++;
        const value = JSON.parse(response.text);
        value.judgments.push({ ...value.judgments[0] });
        response.text = JSON.stringify(value);
      }
      return response;
    } };
    await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm }),
      error => error.code === 'REPORT_OUTPUT_INVALID' && error.phase === 'parse');
    assert.equal(attempts, 2);
  });
}

test('a supported claim with unresolved facets cannot appear as a verified complete answer', async () => {
  const good = canonicalLlm();
  const llm = { async completeWithMetadata(args) {
    const response = await good.completeWithMetadata(args);
    if (args.purpose === 'gap_support') {
      const value = JSON.parse(response.text);
      value.judgments.forEach(item => { item.missingFacets = ['Actual deployment requirements']; });
      response.text = JSON.stringify(value);
    }
    return response;
  } };
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm });
  assert.equal(result.quality.gate, 'fail');
  assert.ok(result.reportPlan.bindings.filter(item => item.required).every(item => item.adequacy !== 'verified'));
  assert.equal(result.reportPlan.claims.filter(item => item.placements.includes('key_findings')).length, 0);
  assert.ok(result.reportPlan.claimRecords.some(record => record.evaluation.verdict === 'supported'));
});

test('report-only resume reuses frozen validated claims and keeps stable IDs', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FileRunRecorder, loadNamedCheckpoint } = await import('../src/research/run-recorder.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-canonical-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = canonicalLlm();
  const broken = { async completeWithMetadata(args) {
    if (args.purpose === 'report') return { text: '', usage: { totalTokens: 100 } };
    return good.completeWithMetadata(args);
  } };
  await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm: broken,
    recorder: new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: '调研 Atlas 这个产品' }) }), { code: 'REPORT_OUTPUT_INVALID' });
  const frozen = loadNamedCheckpoint(dir, 'canonical-claims-validated').state;
  const calls = [];
  const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings,
    recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm({ onCall: ({ purpose }) => calls.push(purpose) }),
    search: { async search() { assert.fail('Report resume must not search'); } } });
  assert.deepEqual(calls, ['report', 'narrative_validation']);
  assert.deepEqual(result.reportPlan.claimRecords.map((item) => item.claimId), frozen.claimRecords.map((item) => item.claimId));
  assert.deepEqual(result.citationRegistry, frozen.citationRegistry);
  assert.equal(result.quality.budget.reservations.length, 0);
});

test('report resume revalidates an older claim review version without searching', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FileRunRecorder, loadNamedCheckpoint } = await import('../src/research/run-recorder.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-review-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = canonicalLlm();
  const recorder = new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: '调研 Atlas 这个产品' });
  await assert.rejects(new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, recorder,
    llm: { async completeWithMetadata(args) {
      return args.purpose === 'report' ? { text: '', usage: { totalTokens: 100 } } : good.completeWithMetadata(args);
    } } }), { code: 'REPORT_OUTPUT_INVALID' });
  const previous = loadNamedCheckpoint(dir, 'canonical-claims-validated').state;
  recorder.checkpoint('canonical-claims-validated', { ...previous, claimReviewVersion: 2 });
  const calls = [];
  const result = await new ResearchRunner().resumeFromSession({ sessionDir: dir, settings,
    recorder: FileRunRecorder.reopen(dir), llm: canonicalLlm({ conflict: true, onCall: ({ purpose }) => calls.push(purpose) }),
    search: { async search() { assert.fail('Report upgrade must not search'); } } });
  assert.deepEqual(calls, ['claim_validation', 'report', 'narrative_validation']);
  assert.equal(result.reportPlan.claimReviewVersion, 3);
  assert.equal(result.quality.gate, 'fail');
  assert.deepEqual(result.reportPlan.claimRecords.map(record => record.claimId), previous.claimRecords.map(record => record.claimId));
});

for (const defect of ['summary', 'render']) {
  test(`report repairs only the affected ${defect} while preserving accepted expressions`, async () => {
    const good = canonicalLlm();
    const requests = [];
    let original;
    let validations = 0;
    const llm = { async completeWithMetadata(args) {
      const response = await good.completeWithMetadata(args);
      if (args.purpose === 'report') {
        const data = JSON.parse(args.messages.find((item) => item.role === 'user').content);
        requests.push(data);
        const value = JSON.parse(response.text);
        if (requests.length === 1) {
          if (defect === 'render') value.renderings[0].text = '';
          original = globalThis.structuredClone(value);
        }
        response.text = JSON.stringify(value);
      }
      if (args.purpose === 'narrative_validation' && defect === 'summary' && ++validations === 1) {
        const value = JSON.parse(response.text);
        value.summaryFaithful = false;
        response.text = JSON.stringify(value);
      }
      return response;
    } };
    const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].limitations, []);
    assert.equal(requests[1].repair.summary, defect === 'summary');
    if (defect === 'summary') {
      assert.deepEqual(requests[1].claims, []);
      assert.deepEqual(requests[1].repair.acceptedContext.renderings, original.renderings);
      assert.equal(requests[1].outputLanguage, 'Chinese');
      assert.deepEqual(result.reportPlan.narrativePlan.renderings, original.renderings);
    } else {
      assert.deepEqual(requests[1].claims.map((claim) => claim.claimId), [original.renderings[0].claimId]);
      assert.equal(result.reportPlan.narrativePlan.summary, original.summary);
    }
    assert.equal(result.quality.gate, 'pass');
  });
}

test('a shared premise remains visible when it also answers a required factual task', async () => {
  const { buildClaimGraph } = await import('../src/research/claim-graph.mjs');
  const store = new EvidenceStore();
  const version = store.register({ url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok' });
  const passage = store.addPassage(version.documentVersionId, 0, body.length);
  const support = { quote: body, quoteAnchored: true, supportingPassageIds: [passage.id], verdict: 'supported' };
  for (const reversed of [false, true]) {
    const gaps = [
      { id: 'comparison', taskType: 'comparison', requiredSlot: true, status: 'verified', slotSupport: { ...support, answer: 'Local processing can support an offline workflow.' } },
      { id: 'fact', taskType: 'fact', requiredSlot: true, status: 'verified', slotSupport: { ...support, answer: body } },
    ];
    const graph = buildClaimGraph({ gaps: reversed ? gaps.reverse() : gaps, passages: [passage] });
    const binding = graph.bindings.find((item) => item.taskId === 'fact');
    assert.equal(graph.records.find((record) => record.claimId === binding.claimId).premiseOnly, false);
    assert.equal(graph.records.length, 2);
  }
});

test('unbound documents remain evidence rather than becoming public claims', async () => {
  const { buildClaimGraph } = await import('../src/research/claim-graph.mjs');
  const store = new EvidenceStore();
  const version = store.register({ url: 'https://atlas.example.com/docs', content: body, fetchStatus: 'ok' });
  const passage = store.addPassage(version.documentVersionId, 0, body.length);
  const graph = buildClaimGraph({ passages: [passage] });
  assert.deepEqual(graph.records, []);
  assert.deepEqual(graph.citationRegistry.entries, []);
  assert.equal(store.passages.size, 1);
});

test('claim revisions retain registered citation keys when earlier observations are omitted', async () => {
  const { buildClaimGraph } = await import('../src/research/claim-graph.mjs');
  const store = new EvidenceStore();
  const passages = ['Unrelated observation.', body].map((content, index) => {
    const version = store.register({ url: `https://atlas.example.com/${index}`, content, fetchStatus: 'ok' });
    return store.addPassage(version.documentVersionId, 0, content.length);
  });
  const priorRegistry = { schemaVersion: 1, entries: passages.map((passage, index) => ({ citationKey: `${index + 1}.1`, sourceId: passage.sourceId,
    documentVersionId: passage.documentVersionId, passageIds: [passage.id], url: passage.url })) };
  const graph = buildClaimGraph({ priorRegistry, passages, gaps: [{ id: 'fact', requiredSlot: true, status: 'verified',
    slotSupport: { quote: body, answer: body, verdict: 'supported', quoteAnchored: true, supportingPassageIds: [passages[1].id] } }] });
  assert.equal(graph.records.length, 1);
  assert.deepEqual(graph.records[0].citationKeys, ['2.1']);
  assert.deepEqual(graph.citationRegistry, priorRegistry);
});

for (const submittedVerdict of ['conflicting', 'supported']) {
test(`canonical counter evidence prevents a ${submittedVerdict} judgment from publishing a conflicting claim`, async () => {
  const counter = 'Atlas is proprietary software. The publisher explicitly states that no MIT license is granted for this product.';
  const good = canonicalLlm();
  let comparisons = 0;
  const llm = { async completeWithMetadata(args) {
    if (args.purpose === 'report') {
      const data = JSON.parse(args.messages.find(item => item.role === 'user').content);
      assert.ok(data.limitations.every(item => !Object.hasOwn(item, 'inspectionStatus')));
      assert.ok(data.limitations.some(item => item.claimVerdict === 'conflicting'));
    }
    if (args.purpose !== 'claim_validation') return good.completeWithMetadata(args);
    const data = JSON.parse(args.messages.find(item => item.role === 'user').content);
    return { text: JSON.stringify({ judgments: data.claims.map(claim => {
      const evidence = claim.comparisonPassages.find(passage => passage.text === counter);
      assert.ok(evidence, 'Review must include the uncited document');
      comparisons++;
      return { claimId: claim.claimId, verdict: submittedVerdict, counterPassageIds: [evidence.id] };
    }) }), usage: { totalTokens: 100 } };
  } };
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, llm,
    search: { async search() { return [...await search.search(), { title: 'Atlas license', url: 'https://atlas.example.com/license', content: counter, fetchStatus: 'ok', contentOrigin: 'provided' }]; } } });
  assert.ok(comparisons > 0);
  assert.equal(result.quality.gate, 'fail');
  assert.ok(result.reportPlan.bindings.filter(item => item.required).every(item => item.adequacy !== 'verified'));
  assert.ok(!result.report.includes('以 MIT 许可证分发'));
  const store = new EvidenceStore(result.evidenceStore);
  for (const record of result.reportPlan.claimRecords) {
    assert.equal(record.evaluation.verdict, 'conflicting');
    assert.equal(record.counterRefs.length, 1);
    assert.equal(store.passages.get(record.counterRefs[0].passageId).text, counter);
    assert.ok(record.evaluation.reviewedPassageIds.includes(record.counterRefs[0].passageId));
  }
});
}

test('new focused research shares canonical evidence and report bindings', async () => {
  const focusedSettings = globalThis.structuredClone(settings);
  focusedSettings.research.strategy = 'focused';
  focusedSettings.research.iterations = 1;
  focusedSettings.research.focused.enableRelevanceFilter = false;
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings: focusedSettings, search, llm: canonicalLlm() });
  assert.equal(result.executionVersion, 2);
  assert.equal(result.reportPlan.schemaVersion, 2);
  assert.equal(result.reportPlan.bindings.filter((binding) => binding.required).length, 1);
  assert.ok(new EvidenceStore(result.evidenceStore).passages.size);
  assert.equal(result.quality.reportContractSatisfied, true);
});

test('canonical inspection uses its existing retry for a noncontiguous quote without weakening anchors', async () => {
  const good = canonicalLlm();
  let gapCalls = 0;
  const llm = { async completeWithMetadata(args) {
    const response = await good.completeWithMetadata(args);
    if (args.purpose === 'gap_support' && ++gapCalls === 1) {
      const value = JSON.parse(response.text);
      for (const judgment of value.judgments) judgment.quote = 'The Atlas tool processes ... under the MIT license.';
      response.text = JSON.stringify(value);
    }
    return response;
  } };
  const result = await new ResearchRunner().run({ query: '调研 Atlas 这个产品', settings, search, llm });
  assert.equal(gapCalls, 2);
  assert.equal(result.quality.gate, 'pass');
  assert.ok(result.gaps.filter(g=>!g.rollup&&g.requiredSlot).every(g=>g.slotSupport.quoteAnchored));
});
