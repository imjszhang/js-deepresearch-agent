import fs from 'node:fs';
import path from 'node:path';
import { exactIds, hash, readJson, writeJson, JUDGE_VERSION } from './schema.mjs';

// Accepted units survive later item errors. The response envelope must still have
// exactly the requested IDs; duplicate/missing/extra IDs invalidate that response.
export async function reviewItems({ judge, purpose, instructions, input, field, validateItem, pendingItem, maxTokens = 4500 }) {
  const items = input[field];
  const identity = hash({ version: JUDGE_VERSION, judge: judge.identity || {}, purpose, instructions, input, maxTokens });
  const file = judge.directory ? path.join(judge.directory, `accepted-${identity}.json`) : null;
  const state = file && fs.existsSync(file) ? readJson(file) : { identity, accepted: {}, rounds: 0, failures: {} };
  if (state.identity !== identity) throw new Error('EVALUATION_CHECKPOINT_IDENTITY');
  const save = () => { if (file) writeJson(file, state); };
  async function call(batch, round) {
    try {
      const result = await judge.ask(purpose, instructions, { ...input, [field]: batch,
        ...(round ? { repair: { codes: Object.fromEntries(batch.map(item => [item.id, state.failures[item.id] || 'item_invalid'])) } } : {}) }, value => exactIds(value[field], batch.map(item => item.id)), maxTokens);
      // Mock judges are subject to the same contract as real judges.
      exactIds(result[field], batch.map(item => item.id));
      for (const value of result[field]) {
        try { validateItem(value, items.find(item => item.id === value.id)); state.accepted[value.id] = value; delete state.failures[value.id]; }
        catch { state.failures[value.id] = 'item_contract_invalid'; }
      }
      save();
    } catch (error) {
      if (/JUDGE_BUDGET_EXCEEDED/.test(error.message) && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await call(batch.slice(0, middle), round); await call(batch.slice(middle), round); return;
      }
      const code = /BUDGET|WALL_CLOCK/.test(error.message) ? 'budget_pending' : /UNKNOWN|PROVIDER_FAILED/.test(error.message) ? 'provider_pending' : 'structure_pending';
      for (const item of batch) state.failures[item.id] = code;
      save();
    }
  }
  while (state.rounds < 2) {
    const remaining = items.filter(item => !state.accepted[item.id] && !['budget_pending', 'provider_pending'].includes(state.failures[item.id]));
    if (!remaining.length) break;
    await call(remaining, state.rounds);
    state.rounds++; save();
  }
  return items.map(item => state.accepted[item.id] || pendingItem(item, state.failures[item.id] || 'review_pending'));
}
