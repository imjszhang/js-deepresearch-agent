import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractReportFacts } from '../scripts/benchmark/quality/report-facts.mjs';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { calibrate } from '../scripts/benchmark/quality/calibrate.mjs';
import { JUDGE_VERSION } from '../scripts/benchmark/quality/schema.mjs';

const assertion = quote => ({ quote, proposition: quote, kind: 'fact', citationKeys: [] });
const content = b => ({ id: b.id, classification: 'content', facts: [assertion(b.text)] });
const coverage = (b, status = 'covered', factIndexes = [0]) => ({ id: b.id,
  checks: b.units.map(u => ({ id: u.id, status, factIndexes })) });
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-extraction-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}

test('empty content stays pending after bounded repair instead of certifying zero facts', async () => {
  let calls = 0;
  const result = await extractReportFacts('Atlas guarantees one million writes per second.', { async ask(purpose, _, input) {
    calls++; assert.equal(purpose, 'extract');
    return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'content', facts: [] })) };
  } });
  assert.equal(calls, 2); assert.equal(result.extractionComplete, false);
  assert.equal(result.extraction[0].classification, 'pending_review');
});

test('empty content repair can recover a fact which then requires independent coverage review', async () => {
  const purposes = [];
  const result = await extractReportFacts('Atlas uses MIT.', { async ask(purpose, _, input) {
    purposes.push(purpose);
    if (purpose === 'audit_extraction') return { blocks: input.blocks.map(b => coverage(b)) };
    return { blocks: input.blocks.map(b => purposes.length === 1 ? { ...content(b), facts: [] } : content(b)) };
  } });
  assert.deepEqual(purposes, ['extract', 'extract', 'audit_extraction']);
  assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 1);
});

test('a cited factual heading cannot disappear even when both responses call it non-content', async () => {
  let auditCalls = 0;
  const result = await extractReportFacts('## Oriel v1 enables encryption by default [1.1]', { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'heading', facts: [] })) };
    auditCalls++; return { blocks: input.blocks.map(b => coverage(b, 'non_assertion', [])) };
  } });
  assert.equal(auditCalls, 2); assert.equal(result.extractionComplete, false);
});

test('uncited factual headings receive an independent audit and omitted assertions remain pending', async () => {
  const result = await extractReportFacts('## Atlas runs offline', { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id, classification: 'heading', facts: [] })) };
    assert.equal(input.blocks[0].units[0].text, '## Atlas runs offline');
    return { blocks: input.blocks.map(b => coverage(b, 'missing', [])) };
  } });
  assert.equal(result.extractionComplete, false); assert.equal(result.extraction[0].pendingReason, 'assertion_omitted');
});

test('partial table extraction cannot certify the retained subset and keeps already extracted facts', async () => {
  const report = '| License | MIT |\n| Encryption | Enabled by default |';
  const result = await extractReportFacts(report, { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b), facts: [assertion(b.text.split('\n')[0])] })) };
    return { blocks: input.blocks.map(b => ({ id: b.id, checks: [
      { id: b.units[0].id, status: 'covered', factIndexes: [0] },
      { id: b.units[1].id, status: 'missing', factIndexes: [] },
    ] })) };
  } });
  assert.equal(result.extractionComplete, false); assert.equal(result.facts.length, 1);
  assert.equal(result.extraction[0].pendingReason, 'assertion_omitted');
});

test('advice with an omitted factual premise is not accepted as completely extracted', async () => {
  const result = await extractReportFacts('Use Atlas because encryption is enabled by default.', { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b),
      facts: [{ ...assertion('Use Atlas'), kind: 'recommendation' }] })) };
    return { blocks: input.blocks.map(b => coverage(b, 'missing', [])) };
  } });
  assert.equal(result.extractionComplete, false); assert.equal(result.facts[0].kind, 'recommendation');
});

test('legitimate headings and reference metadata require, and can pass, independent review', async () => {
  const result = await extractReportFacts('# Findings\n\n[1] Atlas manual: https://atlas.test/manual', { async ask(purpose, _, input) {
    if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ id: b.id,
      classification: b.text.startsWith('#') ? 'heading' : 'bibliography', facts: [] })) };
    return { blocks: input.blocks.map(b => coverage(b, 'non_assertion', [])) };
  } });
  assert.equal(result.extractionComplete, true); assert.equal(result.facts.length, 0);
  assert.ok(result.extraction.every(b => b.coverageChecks.length));
});

test('missing coverage IDs and unrelated quote mappings fail closed', async () => {
  for (const invalid of ['missing_id', 'wrong_quote']) {
    const result = await extractReportFacts('Atlas uses MIT.\nAtlas runs locally.', { async ask(purpose, _, input) {
      if (purpose === 'extract') return { blocks: input.blocks.map(b => ({ ...content(b),
        facts: b.text.split('\n').map(assertion) })) };
      return { blocks: input.blocks.map(b => ({ id: b.id, checks: b.units.slice(0, invalid === 'missing_id' ? 1 : 2)
        .map(u => ({ id: u.id, status: 'covered', factIndexes: [0] })) })) };
    } });
    assert.equal(result.extractionComplete, false, invalid); assert.equal(result.facts.length, 2);
  }
});

test('coverage outage or uncertainty never certifies extraction and keeps existing assertions', async () => {
  for (const failure of ['budget', 'provider', 'unknown']) {
    const result = await extractReportFacts('Atlas uses MIT.', { async ask(purpose, _, input) {
      if (purpose === 'extract') return { blocks: input.blocks.map(content) };
      if (failure !== 'unknown') throw Error(failure === 'budget' ? 'JUDGE_BUDGET_EXCEEDED' : 'JUDGE_OUTCOME_UNKNOWN');
      return { blocks: input.blocks.map(b => coverage(b, 'unknown', [])) };
    } });
    assert.equal(result.extractionComplete, false, failure); assert.equal(result.facts.length, 1);
  }
});

test('production coverage responses retain exact checks, cache accepted work and share the judge ledger', async t => {
  const directory = temporary(t); let calls = 0;
  const options = { directory, identity: {}, llm: { async completeWithMetadata({ messages }) {
    calls++;
    const input = JSON.parse(messages[1].content);
    const blocks = input.blocks.map(b => b.units ? coverage(b) : content(b));
    return { text: JSON.stringify({ blocks, reasoning: 'discard this field' }), usage: { totalTokens: 10 } };
  } } };
  const judge = new Judge(options);
  const first = await extractReportFacts('Atlas uses MIT.', judge);
  assert.equal(first.extractionComplete, true); assert.equal(calls, 2);
  const resumed = new Judge({ ...options, llm: { completeWithMetadata() { assert.fail('accepted work must be reused'); } } });
  assert.deepEqual(await extractReportFacts('Atlas uses MIT.', resumed), first);
  assert.equal(resumed.usage().confirmedTokens, 20); assert.equal(resumed.usage().calls, 2);
  assert.ok(fs.readdirSync(directory).filter(f => f.endsWith('.json')).every(f => !fs.readFileSync(path.join(directory, f), 'utf8').includes('discard this field')));
});

test('empty reports cannot be certified and v4 calibration cannot reuse an exposed holdout', async t => {
  const llm = { completeWithMetadata() { assert.fail('must reject before calls'); } };
  assert.equal((await extractReportFacts('  \n', {})).extractionComplete, false);
  await assert.rejects(calibrate({ llm, directory: temporary(t), identity: {} }), /fresh versioned holdout/);
  await assert.rejects(calibrate({ llm, directory: temporary(t), identity: {},
    holdoutFile: 'tests/fixtures/research-quality/calibration-holdout-v3.json' }), /version differs/);
  const dir = temporary(t), file = path.join(dir, 'relabeled.json');
  const exposed = JSON.parse(fs.readFileSync('tests/fixtures/research-quality/calibration-holdout-v3.json'));
  fs.writeFileSync(file, JSON.stringify({ ...exposed, judgeVersion: JUDGE_VERSION }));
  await assert.rejects(calibrate({ llm, directory: dir, identity: {}, holdoutFile: file }), /exposed/);
});
