import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractReportFacts, reportBlocks } from '../scripts/benchmark/quality/report-facts.mjs';
import { createReportContext, resolveReportContext } from '../scripts/benchmark/quality/report-context.mjs';
import { assertionBindingInput, reviewAssertionBindings } from '../scripts/benchmark/quality/assertion-bindings.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { hash, readJson, writeJson } from '../scripts/benchmark/quality/schema.mjs';
import { selectedFact, faithfulBindings } from './helpers/quality-locators.mjs';

const response = (input, status) => ({ bindings: input.bindings.map(b => ({ id: b.id, status: typeof status === 'function' ? status(b) : status })) });
const contextFor = report => createReportContext(hash(report), reportBlocks(report));
function select(context, quote) {
  const block = context.blocks.find(b => b.text.includes(quote)); assert.ok(block);
  return { unitId: block.locator.units[0].id, quote };
}
function factFor(report, quote, { id = 'fact-1', proposition = quote, contexts = [] } = {}) {
  const context = contextFor(report), located = resolveReportContext(select(context, quote), context);
  const contextLocators = contexts.map(q => resolveReportContext(select(context, q), context));
  return { ...located, id, span: located.originalSpan, proposition, kind: 'fact', citationKeys: [],
    contextLocators, contextSpans: contextLocators.map(c => c.originalSpan) };
}
const cover = block => ({ id: block.id, checks: block.units.map(u => {
  const ids = block.facts.filter(f => f.span[0] < u.span[1] && f.span[1] > u.span[0]).map(f => f.id);
  return { id: u.id, status: ids.length ? 'covered' : 'non_assertion', factIds: ids };
}) });
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-bindings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('[V07] a missing cross-paragraph antecedent is repaired by fact ID and reviewed using bound fragments only', async () => {
  const report = '# Atlas v2\n\nIt can export offline. [1.1]', purposes = [];
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
      facts: b.text.startsWith('#') ? [] : [{ unitId: b.locator.units[0].id, quote: b.text,
        proposition: 'Atlas v2 can export offline.', kind: 'fact', citationKeys: ['1.1'], contextLocators: [] }] })) };
    if (purpose === 'audit_extraction') return { blocks: input.blocks.map(cover) };
    if (purpose === 'audit_bindings') {
      assert.equal(input.blocks, undefined); assert.equal(input.contextBlocks, undefined);
      assert.equal(input.bindings.length, 1);
      assert.ok(input.bindings[0].fragments.every(f => !f.text.includes('Atlas v2')));
      return response(input, 'missing_context');
    }
    if (purpose === 'repair_bindings') {
      assert.equal(input.missingUnits, undefined);
      const heading = input.blocks.find(b => b.text.startsWith('#'));
      return { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [{ unitId: heading.locator.units[0].id, quote: heading.text }] })) };
    }
    assert.equal(purpose, 'audit_bindings_final');
    assert.equal(input.blocks, undefined); assert.equal(input.bindings[0].fragments.length, 2);
    assert.equal(input.bindings[0].fragments[1].text, '# Atlas v2');
    return faithfulBindings(input);
  } });
  assert.deepEqual(purposes, ['extract', 'audit_extraction', 'audit_bindings', 'repair_bindings', 'audit_bindings_final']);
  assert.equal(result.extractionComplete, true); assert.equal(result.bindingComplete, true);
  assert.deepEqual(result.facts[0].contextSpans, [[0, 10]]);
  assert.deepEqual(result.facts[0].citationKeys, ['1.1']);
  assert.equal(result.bindings[0].repairAttempted, true);
});

test('the initial extractor can bind context from another block with the same report identity', async () => {
  const report = '# Atlas v2\n\nOffline export is supported.';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'extract') {
      const heading = [...input.blocks, ...input.contextBlocks].find(b => b.text.startsWith('#'));
      return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: b === heading ? [] : [{ unitId: b.locator.units[0].id,
        quote: b.text, proposition: 'Atlas v2 supports offline export.', kind: 'fact', citationKeys: [],
        contextLocators: [{ unitId: heading.locator.units[0].id, quote: heading.text }] }] })) };
    }
    if (purpose === 'audit_extraction') return { blocks: input.blocks.map(cover) };
    assert.equal(purpose, 'audit_bindings'); return faithfulBindings(input);
  } });
  assert.equal(result.extractionComplete, true);
  assert.deepEqual(result.facts[0].contextSpans, [[0, 10]]);
  assert.equal(result.facts[0].contextLocators[0].owner.reportHash, hash(report));
});

test('an unbound neighboring assertion cannot leak its antecedent into the fidelity request', async () => {
  const report = 'Atlas v2 uses JSON.\n\nIt also supports CSV.';
  const facts = [factFor(report, 'Atlas v2 uses JSON.', { id: 'a' }),
    factFor(report, 'It also supports CSV.', { id: 'b', proposition: 'Atlas v2 supports CSV.' })];
  const inputs = [];
  const result = await reviewAssertionBindings({ report, context: contextFor(report), facts, judge: { async ask(purpose, _, input) {
    if (purpose === 'repair_bindings') return { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [] })) };
    assert.equal(purpose, 'audit_bindings'); assert.equal(input.bindings.length, 1); inputs.push(input);
    if (input.bindings[0].id === 'b') assert.ok(input.bindings[0].fragments.every(f => !f.text.includes('Atlas')));
    return response(input, b => b.id === 'a' ? 'faithful' : 'missing_context');
  } } });
  assert.equal(inputs.length, 2); assert.equal(result.bindingComplete, false);
  assert.deepEqual(result.bindings.map(b => b.status), ['faithful', 'missing_context']);
});

test('[V07] a table value requires its selected row and column context, not a blanket covered row', async () => {
  const report = '| Version | Offline support |\n| v2 | Yes |';
  const fact = factFor(report, 'Yes', { proposition: 'Atlas v2 supports offline operation.' });
  let repair = 0;
  const result = await reviewAssertionBindings({ report, context: contextFor(report), facts: [fact], judge: { async ask(purpose, _, input) {
    if (purpose === 'audit_bindings') return response(input, 'missing_context');
    if (purpose === 'repair_bindings') {
      repair++; const c = contextFor(report);
      return { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [select(c, 'Version | Offline support'), select(c, 'v2')] })) };
    }
    assert.equal(purpose, 'audit_bindings_final');
    assert.deepEqual(input.bindings[0].fragments.map(f => f.text), ['Yes', 'Version | Offline support', 'v2']);
    // Row and column labels still do not identify Atlas, so completion remains
    // blocked instead of inventing a product from the evaluator's knowledge.
    return response(input, 'missing_context');
  } } });
  assert.equal(repair, 1); assert.equal(result.bindingComplete, false);
  assert.equal(result.bindings[0].pendingReason, 'semantic_binding_missing_context');
});

test('a competing version selected as context fails fidelity without another semantic repair', async () => {
  const report = '# Atlas v1\n\n# Atlas v2\n\nIt exports offline.';
  const fact = factFor(report, 'It exports offline.', { proposition: 'Atlas v2 exports offline.' });
  let repairs = 0;
  const result = await reviewAssertionBindings({ report, context: contextFor(report), facts: [fact], judge: { async ask(purpose, _, input) {
    if (purpose === 'audit_bindings') return response(input, 'missing_context');
    if (purpose === 'repair_bindings') { repairs++; return { bindings: input.bindings.map(b => ({ id: b.id,
      contextLocators: [select(contextFor(report), '# Atlas v1')] })) }; }
    assert.equal(input.bindings[0].fragments[1].text, '# Atlas v1'); return response(input, 'not_faithful');
  } } });
  assert.equal(repairs, 1); assert.equal(result.bindings[0].status, 'not_faithful'); assert.equal(result.bindingComplete, false);
});

test('deleting a necessary binding blocks completion even when coverage remains covered', async () => {
  const report = 'Atlas v2:\nIt exports.\nIt exports.';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
      facts: b.units.slice(1).map((u, i) => selectedFact(b, { quote: b.text.slice(...u.span), span: u.span,
        proposition: 'Atlas v2 exports.', kind: 'fact', citationKeys: [], contextSpans: i === 0 ? [[0, 9]] : [] })) })) };
    if (purpose === 'audit_extraction') return { blocks: input.blocks.map(cover) };
    if (purpose === 'repair_bindings') return { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [] })) };
    assert.equal(purpose, 'audit_bindings'); return response(input, b => b.fragments.length > 1 ? 'faithful' : 'missing_context');
  } });
  assert.equal(result.facts.length, 1); assert.equal(result.bindings.length, 2);
  assert.deepEqual(result.facts[0].occurrenceCitations.map(o => o.bindingComplete), [true, false]);
  assert.equal(result.facts[0].bindingComplete, false); assert.equal(result.extractionComplete, false);
  assert.ok(result.extraction[0].coverageChecks.filter(c => c.factIds.length).every(c => c.status === 'covered'));
  assert.equal(result.extraction[0].pendingReason, 'semantic_binding_missing_context');
});

test('[V08] foreign report IDs and context provenance cannot be reused even for identical text', async () => {
  const report = 'Atlas v2\n\nIt exports.';
  const fact = factFor(report, 'It exports.', { proposition: 'Atlas v2 exports.', contexts: ['Atlas v2'] });
  const foreign = contextFor(report + '\nDifferent report.');
  assert.throws(() => resolveReportContext(select(foreign, 'Atlas v2'), contextFor(report)), /unknown_id/);
  fact.contextLocators[0].owner.reportHash = foreign.reportHash;
  assert.throws(() => assertionBindingInput([fact], report, hash(report)), /owner/);
  await assert.rejects(reviewAssertionBindings({ report, context: foreign, facts: [], judge: {} }), /identity/);
});

test('[V08] a real locator from an undisplayed distant block cannot be used during initial extraction', async () => {
  const report = ['Its feature is available.', ...Array.from({ length: 11 }, (_, n) => `# Context ${n}`)].join('\n\n');
  const context = contextFor(report), hidden = context.blocks.at(-1);
  let failedAttempts = 0;
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => {
      if (b.id !== 'block-1') return { id: b.id, classification: 'heading', facts: [] };
      failedAttempts++; assert.ok(![...input.blocks, ...input.contextBlocks].some(shown => shown.id === hidden.id));
      return { id: b.id, classification: 'content', facts: [{ unitId: b.locator.units[0].id, quote: b.text,
        proposition: b.text, kind: 'fact', citationKeys: [], contextLocators: [{ unitId: hidden.locator.units[0].id, quote: hidden.text }] }] };
    }) };
    assert.equal(purpose, 'audit_extraction'); return { blocks: input.blocks.map(cover) };
  } });
  assert.equal(failedAttempts, 2); assert.equal(result.extractionComplete, false);
  assert.equal(result.extraction.find(b => b.blockId === 'block-1').pendingReason, 'locator_unknown_id');
});

for (const [name, quotes] of [['empty', []], ['duplicate', ['# Atlas v2', 'It exports.']], ['subset', ['Atlas']],
  ['repartitioned', ['# Atlas ', 'v2']], ['repeated', ['# Atlas v2', '# Atlas v2']]]) {
  test('[V06] legal repair with no new bound positions completes without another audit: ' + name, async t => {
    const report = '# Atlas v2\n\nIt exports.', context = contextFor(report);
    const fact = factFor(report, 'It exports.', { proposition: 'Atlas v2 exports.', contexts: ['# Atlas v2'] });
    const directory = temp(t), purposes = [];
    const options = { directory, identity: { model: 'scripted-binding-progress' }, assessmentOrigin: 'scripted_fixture', llm: { async completeWithMetadata({ messages }) {
      const input = JSON.parse(messages[1].content);
      const purpose = input.blocks ? 'repair_bindings' : 'audit_bindings'; purposes.push(purpose);
      assert.ok(purposes.length <= 2, 'no-change repair cannot schedule a final audit');
      if (input.blocks) assert.match(messages[0].content, /contextLocators:\[\]/);
      const result = input.blocks ? { bindings: [{ id: 'fact-1', contextLocators: quotes.map(quote => select(context, quote)) }] }
        : { bindings: [{ id: 'fact-1', status: 'missing_context' }] };
      return { text: JSON.stringify(result), usage: { totalTokens: 4 } };
    } } };
    const result = await reviewAssertionBindings({ report, context, facts: [fact], judge: new Judge(options) });
    assert.deepEqual(purposes, ['audit_bindings', 'repair_bindings']); assert.equal(result.bindingComplete, false);
    assert.deepEqual(result.facts[0].contextSpans, fact.contextSpans);
    assert.equal(result.bindings[0].status, 'missing_context'); assert.equal(result.bindings[0].origin, 'scripted_fixture');
    assert.deepEqual(result.bindings[0].repairProgress, { origin: 'program_check', status: 'completed_no_change', addedUtf16Positions: 0 });
    assert.equal(result.bindingIntegrity.status, 'passed'); assert.equal(result.facts[0].bindingIntegrity.status, 'passed');
    const restored = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('no-change outcome must be restored'); } } });
    assert.deepEqual(await reviewAssertionBindings({ report, context, facts: [fact], judge: restored }), result);
    assert.equal(restored.usage().confirmedTokens, 8);
  });
}

test('[V06] an empty top-level bindings list remains an exact-ID error, not a legal empty patch', async () => {
  const report = 'It exports.', calls = [];
  const result = await reviewAssertionBindings({ report, context: contextFor(report), facts: [factFor(report, report)], judge: {
    async ask(purpose, _, input) {
      calls.push(purpose);
      if (purpose === 'audit_bindings') return { bindings: [{ id: 'fact-1', status: 'missing_context' }] };
      assert.equal(purpose, 'repair_bindings');
      if (calls.length === 3) {
        assert.equal(input.repair.codes['fact-1'], 'id_set_invalid');
        assert.deepEqual(input.repair.errors['fact-1'].missingIds, ['fact-1']);
      }
      return { bindings: [] };
    },
  } });
  assert.deepEqual(calls, ['audit_bindings', 'repair_bindings', 'repair_bindings']);
  assert.equal(result.bindings[0].pendingReason, 'id_set_invalid');
  assert.equal(result.bindings[0].repairProgress.status, 'incomplete');
  assert.equal(result.bindingIntegrity.status, 'passed');
});

test('[V07] identical text at another original position is real binding progress', async () => {
  const report = '# Atlas v2\n\nIt exports.\n\n# Atlas v2', context = contextFor(report), calls = [];
  const fact = factFor(report, 'It exports.', { proposition: 'Atlas v2 exports.', contexts: ['# Atlas v2'] });
  const result = await reviewAssertionBindings({ report, context, facts: [fact], judge: { async ask(purpose, _, input) {
    calls.push(purpose);
    if (purpose === 'audit_bindings') return { bindings: [{ id: 'fact-1', status: 'missing_context' }] };
    if (purpose === 'repair_bindings') return { bindings: [{ id: 'fact-1', contextLocators: [{ unitId: context.blocks.at(-1).locator.units[0].id, quote: '# Atlas v2' }] }] };
    assert.equal(purpose, 'audit_bindings_final');
    assert.equal(input.bindings[0].fragments[1].text, input.bindings[0].fragments[2].text);
    assert.notDeepEqual(input.bindings[0].fragments[1].span, input.bindings[0].fragments[2].span);
    return { bindings: [{ id: 'fact-1', status: 'not_faithful' }] };
  } } });
  assert.deepEqual(calls, ['audit_bindings', 'repair_bindings', 'audit_bindings_final']);
  assert.deepEqual(result.bindings[0].repairProgress, { origin: 'program_check', status: 'completed_changed', addedUtf16Positions: 10 });
  assert.equal(result.bindingIntegrity.status, 'passed'); assert.equal(result.bindingAssessment.complete, false);
});

test('[V09] binding progress counts UTF-16 positions and rejects a split surrogate pair', async () => {
  const report = '🙂 Atlas\n\nIt exports.', context = contextFor(report);
  for (const quote of ['🙂', '\ud83d']) {
    const calls = [];
    const result = await reviewAssertionBindings({ report, context, facts: [factFor(report, 'It exports.')], judge: {
      async ask(purpose) {
        calls.push(purpose);
        if (purpose === 'audit_bindings') return { bindings: [{ id: 'fact-1', status: 'missing_context' }] };
        if (purpose === 'repair_bindings') return { bindings: [{ id: 'fact-1', contextLocators: [select(context, quote)] }] };
        assert.equal(quote, '🙂'); return { bindings: [{ id: 'fact-1', status: 'not_faithful' }] };
      },
    } });
    assert.equal(result.bindingIntegrity.status, 'passed');
    if (quote === '🙂') {
      assert.equal(result.bindings[0].repairProgress.addedUtf16Positions, 2);
      assert.deepEqual(calls, ['audit_bindings', 'repair_bindings', 'audit_bindings_final']);
    } else {
      assert.equal(result.bindings[0].pendingReason, 'locator_surrogate_boundary');
      assert.deepEqual(calls, ['audit_bindings', 'repair_bindings', 'repair_bindings']);
    }
  }
});

test('binding budget or provider pause takes priority over a prior semantic failure in the same block', async () => {
  for (const failure of ['JUDGE_BUDGET_EXCEEDED', 'JUDGE_PROVIDER_FAILED']) {
    let audits = 0;
    const result = await extractReportFacts('A is true.\nB is true.', { async ask(purpose, _, input) {
      if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
        facts: b.units.map(u => selectedFact(b, { quote: b.text.slice(...u.span), span: u.span, proposition: b.text.slice(...u.span), kind: 'fact', citationKeys: [] })) })) };
      if (purpose === 'audit_extraction') return { blocks: input.blocks.map(cover) };
      assert.equal(purpose, 'audit_bindings'); audits++;
      if (audits === 1) return response(input, 'not_faithful');
      throw Error(failure);
    } });
    assert.equal(result.bindings[0].status, 'not_faithful'); assert.equal(result.bindings[1].status, 'uncertain');
    assert.equal(result.extraction[0].pendingReason, failure.includes('BUDGET') ? 'budget_pending' : 'provider_pending');
  }
});

test('every occurrence needs exactly one valid binding response; structural correction has two attempts', async () => {
  const report = 'A is true.', fact = factFor(report, report); let calls = 0;
  const result = await reviewAssertionBindings({ report, context: contextFor(report), facts: [fact], judge: { async ask(_, __, input) {
    calls++; return { bindings: [...input.bindings.map(b => ({ id: b.id, status: 'faithful' })), { id: 'extra', status: 'faithful' }] };
  } } });
  assert.equal(calls, 2); assert.equal(result.bindingComplete, false); assert.equal(result.bindings[0].status, 'uncertain');
});

test('self-contained multilingual paraphrases need no artificial context binding', async () => {
  for (const [report, proposition] of [['Atlas v2 可以离线导出。', 'Version two of Atlas permits offline export.'], ['Atlas version two does not export offline.', 'Atlas 第二版不支持离线导出。']]) {
    const result = await reviewAssertionBindings({ report, context: contextFor(report), facts: [factFor(report, report, { proposition })], judge: { async ask(purpose, _, input) {
      assert.equal(purpose, 'audit_bindings'); assert.equal(input.bindings[0].fragments.length, 1); return faithfulBindings(input);
    } } });
    assert.equal(result.bindingComplete, true); assert.equal(result.bindings[0].repairAttempted, false);
  }
});

test('binding repair and final audit resume without extra requests, and changed context invalidates the audit', async t => {
  const report = 'Atlas v2\n\nIt exports.', fact = factFor(report, 'It exports.', { proposition: 'Atlas v2 exports.' });
  const directory = temp(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    const result = input.blocks ? { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [select(contextFor(report), 'Atlas v2')] })) }
      : response(input, b => b.fragments.length > 1 ? 'faithful' : 'missing_context');
    return { text: JSON.stringify(result), usage: { totalTokens: 10 } };
  } } };
  const args = { report, context: contextFor(report), facts: [fact] };
  const first = await reviewAssertionBindings({ ...args, judge: new Judge(options) }); assert.equal(first.bindingComplete, true); assert.equal(calls, 3);
  const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('unexpected dispatch'); } } });
  assert.deepEqual(await reviewAssertionBindings({ ...args, judge: resumed }), first); assert.equal(resumed.usage().confirmedTokens, 30);
  const changed = report.replace('v2', 'v3'), changedFact = factFor(changed, 'It exports.', { proposition: 'Atlas v3 exports.', contexts: ['Atlas v3'] });
  const next = await reviewAssertionBindings({ report: changed, context: contextFor(changed), facts: [changedFact], judge: new Judge(options) });
  assert.equal(next.bindingComplete, true); assert.equal(calls, 4);
  assert.notEqual(next.bindings[0].bindingHash, first.bindings[0].bindingHash);
});

test('a retried target keeps accepted sibling context in its frozen physical payload and recovers the receipt', async t => {
  const report = '# Atlas v2\n\nIt exports.', directory = temp(t);
  let calls = 0, delayedInput;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    if (input.blocks.length === 2) return { text: JSON.stringify({ blocks: input.blocks.map(b => ({ id: b.id, classification: 'content',
      facts: b.text.startsWith('#') ? [] : [{ unitId: 'invalid-unit', quote: b.text, proposition: 'Atlas v2 exports.', kind: 'fact', citationKeys: [] }] })) }), usage: { totalTokens: 10 } };
    assert.deepEqual(input.blocks.map(b => b.id), ['block-2']);
    assert.equal(input.contextBlocks.find(b => b.id === 'block-1').text, '# Atlas v2');
    assert.equal(new Set([...input.blocks, ...input.contextBlocks].map(b => b.id)).size, 2);
    delayedInput = input; throw Error('lost response');
  } } };
  const initial = new Judge(options);
  const first = await extractReportFacts(report, initial); assert.equal(first.extractionComplete, false); assert.equal(calls, 2);
  const callId = Object.keys(initial.ledger.calls).find(id => initial.ledger.calls[id].tokens == null);
  const extractionState = fs.readdirSync(directory).filter(f => f.startsWith('accepted-')).map(f => readJson(path.join(directory, f)))
    .find(s => s.inflight?.input.blocks?.[0]?.locator);
  assert.deepEqual(extractionState.inflight.input, delayedInput);
  const heading = delayedInput.contextBlocks.find(b => b.id === 'block-1');
  writeJson(path.join(directory, callId + '.json'), { text: JSON.stringify({ blocks: delayedInput.blocks.map(b => ({ id: b.id, classification: 'content',
    facts: [{ unitId: b.locator.units[0].id, quote: b.text, proposition: 'Atlas v2 exports.', kind: 'fact', citationKeys: [],
      contextLocators: [{ unitId: heading.locator.units[0].id, quote: heading.text }] }] })) }), usage: { totalTokens: 13 }, activeMs: 1 });
  const resumed = new Judge({ ...options, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    return { text: JSON.stringify(input.bindings ? faithfulBindings(input) : { blocks: input.blocks.map(cover) }), usage: { totalTokens: 7 } };
  } } });
  const second = await extractReportFacts(report, resumed); assert.equal(second.extractionComplete, true);
  assert.deepEqual(second.facts[0].contextSpans, [[0, 10]]); assert.equal(resumed.usage().confirmedTokens, 37);
  const before = calls;
  assert.deepEqual(await extractReportFacts(report, resumed), second); assert.equal(calls, before);
});

for (const changedContext of [false, true]) test('late repair receipts use frozen members and context: ' + changedContext, async t => {
  const report = 'Atlas v2\n\nIt exports.\n\nIt reads.';
  const facts = [factFor(report, 'It exports.', { id: 'a', proposition: 'Atlas v2 exports.' }), factFor(report, 'It reads.', { id: 'b', proposition: 'Atlas v2 reads.' })];
  const directory = temp(t); let calls = 0, delayedInput;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    if (input.blocks) { delayedInput = input; throw Error('lost repair response'); }
    return { text: JSON.stringify(response(input, 'missing_context')), usage: { totalTokens: 10 } };
  } } };
  const initial = new Judge(options);
  const first = await reviewAssertionBindings({ report, context: contextFor(report), facts, judge: initial });
  assert.equal(first.bindingComplete, false); assert.equal(calls, 3);
  const callId = Object.keys(initial.ledger.calls).find(id => initial.ledger.calls[id].tokens == null);
  writeJson(path.join(directory, callId + '.json'), { text: JSON.stringify({ bindings: delayedInput.bindings.map(b => ({ id: b.id,
    contextLocators: [select(contextFor(report), 'Atlas v2')] })) }), usage: { totalTokens: 13 }, activeMs: 1 });
  const resumed = new Judge({ ...options, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    return { text: JSON.stringify(input.blocks ? { bindings: input.bindings.map(b => ({ id: b.id, contextLocators: [] })) } : faithfulBindings(input)), usage: { totalTokens: 7 } };
  } } });
  const context = changedContext ? { reportHash: hash(report), catalogs: [], blocks: [] } : contextFor(report);
  const second = await reviewAssertionBindings({ report, context, facts: [facts[1]], judge: resumed });
  assert.equal(second.bindingComplete, !changedContext);
  assert.equal(resumed.usage().unknownCalls, 0); assert.equal(resumed.usage().confirmedTokens, 40);
  const repairState = fs.readdirSync(directory).filter(f => f.startsWith('components-')).map(f => readJson(path.join(directory, f)))
    .find(s => Object.values(s.records).some(r => r.dependencies?.originalFact));
  assert.ok(Object.values(repairState.accepted).some(r => r.id === 'a' && r.contextLocators.length === 1));
  assert.ok(Object.values(repairState.accepted).some(r => r.id === 'b' && r.contextLocators.length === 1));
});
