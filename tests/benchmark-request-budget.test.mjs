import assert from 'node:assert/strict';
import test from 'node:test';
import { faithfulBindings } from './helpers/quality-locators.mjs';
import { locatorCatalog, locatorInput, resolveLocator, LOCATOR_VERSION } from '../scripts/benchmark/quality/locators.mjs';
import { extractReportFacts, reportExtractionRequests } from '../scripts/benchmark/quality/report-facts.mjs';
import { conservativeRequestReservation, evaluatorMessages, packRequestItems, requestPlanEnvelope } from '../scripts/benchmark/quality/request-budget.mjs';

test('locator transport refers to its one raw owner text while preserving UTF-16 resolution', () => {
  const text = '条件：离线😀。\r\nProduct supports fullwidth Ａ and e\u0301.\n| Version | v2 |';
  const catalog = locatorCatalog(text, { sourceId: 'source-1', version: 'v2' }, 19);
  const input = { text, locator: locatorInput(catalog) };
  assert.equal(LOCATOR_VERSION, 2);
  assert.ok(input.locator.units.every(u => !Object.hasOwn(u, 'text') && Array.isArray(u.range)));
  for (const unit of input.locator.units) {
    const quote = input.text.slice(...unit.range);
    const result = resolveLocator({ unitId: unit.id, quote }, catalog);
    assert.equal(result.quote, quote);
    assert.deepEqual(result.originalSpan, unit.range.map(n => n + 19));
  }
  const sameBodyOtherOwner = locatorCatalog(text, { sourceId: 'source-2', version: 'v2' }, 19);
  assert.throws(() => resolveLocator({ unitId: input.locator.units[0].id, quote: text }, sameBodyOtherOwner), /unknown_id/);
});

test('extraction, audit and targeted repair share one complete block body with referenced units', async () => {
  const report = '| Version | Requirement |\r\n| v1 | Offline mode is required. |';
  const seen = [];
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    seen.push(purpose);
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    return { blocks: input.blocks.map(b => {
      assert.equal(b.text, report);
      assert.ok(b.units.every(u => !Object.hasOwn(u, 'text') && b.text.slice(...u.span).trim()));
      if (purpose.startsWith('extract')) {
        assert.ok(b.locator.units.every(u => !Object.hasOwn(u, 'text')));
        const facts = purpose === 'extract' ? [] : [{ unitId: b.locator.units[0].id,
          quote: '| v1 | Offline mode is required. |', proposition: 'Version 1 requires offline mode.',
          kind: 'fact', citationKeys: [], contextLocators: [{ unitId: b.locator.units[0].id, quote: '| Version | Requirement |' }] }];
        return { id: b.id, classification: 'table', facts };
      }
      assert.ok(b.facts.every(f => !Object.hasOwn(f, 'quote') && !Object.hasOwn(f, 'contextLocators')));
      return { id: b.id, checks: b.units.map((u, i) => ({ id: u.id,
        status: i === 0 ? 'non_assertion' : b.facts.length ? 'covered' : 'missing',
        factIds: i === 0 ? [] : b.facts.map(f => f.id) })) };
    }) };
  } });
  assert.deepEqual(seen, ['extract', 'audit_extraction', 'extract_repair', 'audit_extraction_final', 'audit_bindings']);
  assert.equal(result.extractionComplete, true);
  assert.deepEqual(result.facts[0].contextSpans, [[0, 25]]);
});

test('size packing preserves every complete owner and original stable locator IDs', () => {
  const report = Array.from({ length: 7 }, (_, n) => `Block ${n}: ${'字😀'.repeat(2000)}`).join('\n\n');
  const requests = reportExtractionRequests(report), blocks = requests.flatMap(r => r.input.blocks);
  assert.ok(requests.length > 2);
  assert.equal(blocks.length, 7);
  for (const block of blocks) {
    assert.equal(report.slice(block.start, block.start + block.text.length), block.text);
    const expected = locatorInput(locatorCatalog(block.text, block.locator.owner, block.start));
    assert.deepEqual(block.locator, expected);
    assert.equal(block.text.endsWith('字😀'), true);
  }
  const again = packRequestItems(blocks, { buildMessages: items => evaluatorMessages('check', { blocks: items }), maxItems: 7, maxReservation: 1000000 });
  assert.equal(again.length, 1); assert.deepEqual(again.flat(), blocks);
});

test('a request too large for a batch remains whole and yields pending when the ledger rejects admission', async () => {
  const report = 'A'.repeat(33000) + '😀 assertion remains visible.';
  const requests = reportExtractionRequests(report);
  assert.equal(requests.length, 1); assert.equal(requests[0].input.blocks[0].text, report);
  let dispatches = 0;
  const result = await extractReportFacts(report, { async ask(_, __, input) {
    dispatches++; assert.equal(input.blocks[0].text, report); throw Error('JUDGE_BUDGET_EXCEEDED');
  } });
  assert.equal(dispatches, 1); assert.equal(result.extractionComplete, false);
  assert.equal(result.extraction[0].pendingReason, 'budget_pending');
});

test('request reservations count UTF-8 bytes and output ceilings without token heuristics', () => {
  const messages = evaluatorMessages('核验', { text: '中文😀 e\u0301\r\n' });
  assert.equal(conservativeRequestReservation(messages, 4500), Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4500);
  assert.ok(conservativeRequestReservation(messages, 4500) > JSON.stringify(messages).length + 4500);
  const plan = requestPlanEnvelope([{ id: 'extract-1', stage: 'development', messages, maxOutputTokens: 4500, maxAttempts: 2 }]);
  assert.equal(plan.maximumDispatches, 2);
  assert.equal(plan.maximumReservation, conservativeRequestReservation(messages, 4500) * 2);
  assert.equal(plan.policy, 'utf8_bytes_plus_output_limit');
  assert.equal(requestPlanEnvelope([]).largestReservation, 0);
  assert.throws(() => requestPlanEnvelope([{ id: 'same', messages }, { id: 'same', messages }]), /Duplicate/);
  assert.throws(() => conservativeRequestReservation(messages, -1), /Invalid/);
});

test('packing uses actual serialized request size, retains order and never truncates oversized owners', () => {
  const items = [{ id: 'a', text: '😀'.repeat(30) }, { id: 'b', text: 'B'.repeat(300) }, { id: 'c', text: 'C' }];
  const buildMessages = batch => evaluatorMessages('verify', { items: batch });
  const target = conservativeRequestReservation(buildMessages([items[0]]), 10);
  const batches = packRequestItems(items, { buildMessages, maxOutputTokens: 10, maxReservation: target });
  assert.deepEqual(batches, [[items[0]], [items[1]], [items[2]]]);
  assert.ok(conservativeRequestReservation(buildMessages(batches[1]), 10) > target);
});

test('compact extraction removes duplicate bodies without hiding any original text', () => {
  const report = Array.from({ length: 40 }, (_, n) => `Line ${n}: ${'body content '.repeat(30)}`).join('\n');
  const request = reportExtractionRequests(report)[0], block = request.input.blocks[0];
  const oldBlock = { ...block, locator: { ...block.locator,
    units: block.locator.units.map(u => ({ ...u, text: block.text.slice(...u.range) })) },
  units: block.units.map(u => ({ ...u, text: block.text.slice(...u.span) })) };
  const compact = conservativeRequestReservation(evaluatorMessages(request.instructions, request.input), 4500);
  const repeated = conservativeRequestReservation(evaluatorMessages(request.instructions, { ...request.input, blocks: [oldBlock] }), 4500);
  assert.ok(compact < repeated * 0.6);
  assert.equal(block.text, report);
});

test('a many-block report keeps each initial request bounded instead of repeating the whole report', () => {
  const report = Array.from({ length: 80 }, (_, n) => `## Section ${n}\n${'Detailed body content. '.repeat(80)}`).join('\n\n');
  assert.ok(report.length > 100000);
  const requests = reportExtractionRequests(report);
  assert.equal(requests.flatMap(r => r.input.blocks).length, 80);
  for (const r of requests) {
    const displayed = [...r.input.blocks, ...r.input.contextBlocks];
    assert.equal(new Set(displayed.map(b => b.id)).size, displayed.length);
    assert.ok(displayed.reduce((n, b) => n + b.text.length, 0) < report.length / 4);
    assert.ok(conservativeRequestReservation(evaluatorMessages(r.instructions, r.input), r.maxOutputTokens) <= 32000);
    assert.equal(r.input.contextScope, 'partial'); assert.ok(r.input.omittedContextBlockCount > 0);
    assert.ok(r.input.blocks.every(b => b.contextBlockIds.every(id => displayed.some(other => other.id === id))));
  }
});
