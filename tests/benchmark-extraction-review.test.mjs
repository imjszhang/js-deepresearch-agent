import { selectedFact, faithfulBindings } from './helpers/quality-locators.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractReportFacts } from '../scripts/benchmark/quality/report-facts.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { calibrate } from '../scripts/benchmark/quality/calibrate.mjs';

const assertion = (quote, start = 0) => ({ quote, span: [start, start + quote.length], proposition: quote, kind: 'fact', citationKeys: [] });
const content = b => ({ id: b.id, classification: 'content', facts: [selectedFact(b, assertion(b.text))] });
const coverage = (b, status = 'covered') => ({ id: b.id, checks: b.units.map(u => ({ id: u.id, status,
  factIds: status === 'covered' ? b.facts.filter(f => f.span[0] < u.span[1] && f.span[1] > u.span[0]).map(f => f.id) : [] })) });
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-extraction-v5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('empty extraction is audited, repaired once and audited again', async () => {
  const purposes = [];
  const result = await extractReportFacts('## Atlas runs offline', { async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b), classification: 'heading', facts: [] })) };
    if (purpose === 'extract_repair') return { blocks: input.blocks.map(b => ({ ...content(b), classification: 'heading' })) };
    return { blocks: input.blocks.map(b => coverage(b, b.facts.length ? 'covered' : 'missing')) };
  } });
  assert.deepEqual(purposes, ['extract', 'audit_extraction', 'extract_repair', 'audit_extraction_final', 'audit_bindings']);
  assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 1);
});
test('persistent omission stays pending without a second semantic repair', async () => {
  const purposes = [];
  const result = await extractReportFacts('Atlas runs offline.', { async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    return { blocks: input.blocks.map(b => purpose.startsWith('extract') ? { ...content(b), facts: [] } : coverage(b, 'missing')) };
  } });
  assert.equal(purposes.filter(p => p === 'extract_repair').length, 1);
  assert.equal(result.extraction[0].pendingReason, 'assertion_omitted');
});
test('cited heading cannot be certified as non-assertion by both model calls', async () => {
  let audits = 0;
  const result = await extractReportFacts('## Atlas runs offline [1.1]', { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b), classification: 'heading', facts: [] })) };
    audits++; return { blocks: input.blocks.map(b => coverage(b, 'non_assertion')) };
  } });
  assert.equal(audits, 2); assert.equal(result.extractionComplete, false);
});
test('targeted table repair preserves accepted facts and receives missing row plus headers', async () => {
  const report = '| License | MIT |\n| Encryption | Enabled |';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b), facts: [selectedFact(b, assertion(b.text.split('\n')[0]))] })) };
    if (purpose === 'extract_repair') return { blocks: input.blocks.map(b => {
      assert.equal(b.missingUnits.length, 1); assert.equal(b.acceptedFacts.length, 1); assert.equal(b.text, report);
      return { ...content(b), facts: [selectedFact(b, assertion(b.text.slice(...b.missingUnits[0].span), b.missingUnits[0].span[0]))] };
    }) };
    return { blocks: input.blocks.map(b => {
      const checked = coverage(b); checked.checks.forEach(c => { if (!c.factIds.length) c.status = 'missing'; }); return checked;
    }) };
  } });
  assert.equal(result.facts.length, 2); assert.equal(result.extractionComplete, true);
});
test('duplicate quote locations remain distinct and each occurrence is audited', async () => {
  const report = 'Atlas runs offline.\nAtlas runs offline.';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    return { blocks: input.blocks.map(b => purpose === 'extract'
      ? { ...content(b), facts: b.units.map(u => selectedFact(b, assertion(b.text.slice(...u.span), u.span[0]))) } : coverage(b)) };
  } });
  assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 1);
  assert.deepEqual(result.facts[0].occurrences, [[0, 19], [20, 39]]);
  assert.equal(result.facts[0].occurrenceCitations.length, 2);
});
test('incorrect spans cannot be silently relocated to the first matching quote', async () => {
  const result = await extractReportFacts('Atlas runs offline.', { async ask(_, __, input) {
    return { blocks: input.blocks.map(b => ({ ...content(b), facts: [selectedFact(b, assertion(b.text, 1))] })) };
  } });
  assert.equal(result.extractionComplete, false); assert.equal(result.facts.length, 0);
});
test('pure headings and metadata pass audit with zero technical assertions', async () => {
  const result = await extractReportFacts('# Findings\n\n[1] Atlas manual: https://atlas.test/manual', { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
    return { blocks: input.blocks.map(b => purpose === 'extract' ? { ...content(b), classification: 'heading', facts: [] } : coverage(b, 'non_assertion')) };
  } });
  assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 0);
});
test('unknown coverage and outages keep accepted facts and never trigger semantic repair', async () => {
  for (const failure of ['budget', 'provider', 'unknown']) {
    const purposes = [];
    const result = await extractReportFacts('Use Atlas because it runs offline.', { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
      purposes.push(purpose);
      if (purpose === 'extract') return { blocks: input.blocks.map(content) };
      if (failure !== 'unknown') throw Error(failure === 'budget' ? 'JUDGE_BUDGET_EXCEEDED' : 'JUDGE_OUTCOME_UNKNOWN');
      return { blocks: input.blocks.map(b => coverage(b, 'unknown')) };
    } });
    assert.equal(result.extractionComplete, false); assert.equal(result.facts.length, 1);
    assert.ok(!purposes.includes('extract_repair'));
  }
});
test('missing coverage IDs and unrelated span mappings fail closed', async () => {
  for (const invalid of ['missing', 'unrelated']) {
    const result = await extractReportFacts('Atlas uses MIT.\nAtlas runs locally.', { async ask(purpose, _, input) {
    if (purpose.startsWith('audit_bindings')) return faithfulBindings(input);
      return { blocks: input.blocks.map(b => {
        if (purpose === 'extract') return { ...content(b), facts: b.units.map(u => selectedFact(b, assertion(b.text.slice(...u.span), u.span[0]))) };
        const checked = coverage(b);
        if (invalid === 'missing') checked.checks.pop(); else checked.checks[1].factIds = [b.facts[0].id]; return checked;
      }) };
    } });
    assert.equal(result.extractionComplete, false); assert.equal(result.facts.length, 2);
  }
});
test('production repair checkpoints resume without model calls or double settlement', async t => {
  const directory = temporary(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++; const input = JSON.parse(messages[1].content);
    if (input.bindings) return { text: JSON.stringify(faithfulBindings(input)), usage: { totalTokens: 10 } };
    const blocks = input.blocks.map(b => b.facts ? coverage(b, b.facts.length ? 'covered' : 'missing')
      : b.acceptedFacts ? content(b) : { ...content(b), facts: [] });
    return { text: JSON.stringify({ blocks, reasoning: 'discard this' }), usage: { totalTokens: 10 } };
  } } };
  const first = await extractReportFacts('Atlas uses MIT.', new Judge(options));
  assert.equal(first.extractionComplete, true); assert.equal(calls, 5);
  const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail(); } } });
  assert.deepEqual(await extractReportFacts('Atlas uses MIT.', resumed), first);
  assert.equal(resumed.usage().confirmedTokens, 50);
});
test('empty reports and legacy holdouts cannot certify the v5 evaluator', async t => {
  assert.equal((await extractReportFacts('  \n', {})).extractionComplete, false);
  await assert.rejects(calibrate({ directory: temporary(t), identity: {}, holdoutFile: 'old.json' }), /versioned suite/);
});
