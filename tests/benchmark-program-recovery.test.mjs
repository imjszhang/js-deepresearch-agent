import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Judge } from '../scripts/benchmark/quality/judge.mjs';
import { reviewItems } from '../scripts/benchmark/quality/item-review.mjs';
import { ScriptedProvider } from './helpers/scripted-provider.mjs';

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-program-recovery-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const read = file => JSON.parse(fs.readFileSync(file));
function parameters(judge, id, version, maxTokens = 100) {
  return { judge, purpose: 'program_fixture', instructions: 'Fixed program recovery fixture.', field: 'checks',
    input: { materialVersion: version, checks: [{ id }] }, maxTokens, components: { scope: 'program-recovery-v1', dependencies: () => ({ version }) },
    validateItem: value => assert.equal(value.ok, true), pendingItem: (item, pendingReason) => ({ id: item.id, pendingReason }) };
}

test('[V13] saved receipt replays through the production Judge with a dispatch-forbidden provider', async t => {
  const directory = temporary(t), provider = new ScriptedProvider([{ purpose: 'program_fixture', instructions: 'Fixed program recovery fixture.',
    field: 'checks', ids: ['one'], attempt: 1, response: { checks: [{ id: 'one', ok: true }] }, tokens: 7 }]);
  const first = new Judge({ directory, assessmentOrigin: 'scripted_fixture', identity: { model: 'scripted_fixture' }, llm: provider });
  assert.equal((await reviewItems(parameters(first, 'one', 1)))[0].ok, true); provider.assertConsumed();
  const before = first.usage();
  const stateFile = fs.readdirSync(directory).find(f => f.startsWith('components-'));
  fs.rmSync(path.join(directory, stateFile));
  const replay = new Judge({ directory, assessmentOrigin: 'scripted_fixture', identity: { model: 'scripted_fixture' }, llm: { completeWithMetadata() { assert.fail('Replay dispatched a real request'); } } });
  assert.equal((await reviewItems(parameters(replay, 'one', 1)))[0].ok, true);
  assert.deepEqual(replay.usage(), before);
});

test('[V12] 64 fixed seeds by 40 steps compare recovery and admission with an independent state table', { timeout: 120000 }, async t => {
  const base = temporary(t);
  for (let seed = 1; seed <= 64; seed++) {
    const directory = path.join(base, String(seed)); let random = seed, mode = 'valid', sent = 0, knownTokens = 0, flight = null;
    const reference = new Map(), trace = [];
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    const provider = { async completeWithMetadata({ messages }) {
      sent++;
      if (mode === 'unknown') throw Error('SCRIPTED_UNKNOWN_OUTCOME');
      const input = JSON.parse(messages[1].content);
      return { text: JSON.stringify({ checks: input.checks.map(c => ({ id: c.id, ok: mode !== 'invalid' })) }), usage: { totalTokens: 3 } };
    } };
    let expectedCalls = 0;
    try {
      for (let step = 0; step < 40; step++) {
        const id = ['a', 'b', 'c'][next() % 3], version = next() % 3, op = next() % 7, key = `${id}:${version}`;
        trace.push({ step, item: id, version, op });
        if (flight && op === 4) {
          const ledger = read(path.join(directory, 'ledger.json')), callId = Object.keys(ledger.calls).find(k => ledger.calls[k].tokens == null);
          fs.writeFileSync(path.join(directory, `${callId}.json`), JSON.stringify({ text: JSON.stringify({ checks: [{ id: flight.id, ok: true }] }), usage: { totalTokens: 3 }, activeMs: 0 }));
          reference.get(flight.key).accepted = true; knownTokens += 3; flight = null;
        }
        const state = reference.get(key) || { attempts: 0, accepted: false }; reference.set(key, state);
        mode = op === 0 ? 'budget' : op === 1 ? 'invalid' : op === 2 ? 'unknown' : 'valid';
        if (!flight && !state.accepted && state.attempts < 2 && mode !== 'budget') {
          if (mode === 'invalid') { const count = 2 - state.attempts; state.attempts = 2; expectedCalls += count; knownTokens += 3 * count; }
          else { state.attempts++; expectedCalls++; if (mode === 'unknown') flight = { key, id }; else { state.accepted = true; knownTokens += 3; } }
        }
        const judge = new Judge({ directory, assessmentOrigin: 'scripted_fixture', identity: { model: 'scripted_fixture' }, limit: 1000000, llm: provider });
        const originalAsk = judge.ask.bind(judge);
        judge.ask = (...args) => { if (mode === 'budget' && !Object.values(judge.ledger.calls).some(c => c.tokens == null)) throw Error('JUDGE_STAGE_BUDGET_EXCEEDED'); return originalAsk(...args); };
        const result = await reviewItems(parameters(judge, id, version, 100 + next() % 100));
        const context = `seed=${seed},step=${step},trace=${JSON.stringify(trace)}`;
        assert.equal(Boolean(result[0].ok), state.accepted, context);
        assert.equal(sent, expectedCalls, context);
        assert.equal(judge.usage().confirmedTokens, knownTokens, context);
        assert.equal(judge.usage().unknownCalls, flight ? 1 : 0, context);
        const cache = read(path.join(directory, fs.readdirSync(directory).find(f => f.startsWith('components-'))));
        for (const [componentKey, record] of Object.entries(cache.records)) {
          const expected = reference.get(`${record.item.id}:${record.dependencies.version}`);
          assert.equal(cache.attempts[componentKey] || 0, expected.attempts, context);
          assert.equal(Boolean(cache.accepted[componentKey]), expected.accepted, context);
        }
      }
    } catch (error) {
      error.verificationFailure = { schemaVersion: 1, seed, step: trace.at(-1).step, operations: trace };
      throw error;
    }
  }
});
