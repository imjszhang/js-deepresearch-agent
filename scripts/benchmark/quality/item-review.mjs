import fs from 'node:fs';
import path from 'node:path';
import { exactIds, hash, readJson, writeJson, JUDGE_VERSION } from './schema.mjs';

const componentStates = new WeakMap();
const safeCode = value => typeof value === 'string' && /^(?:locator|item|component|relation|citation|evidence|semantic|counterevidence|mapping|execution|schema|id)_[a-z0-9_]{1,64}$/.test(value);
const safeField = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.[\]-]{0,119}$/.test(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value);

// Callers supply program-generated codes and identifiers, never provider prose.
// Neither an Error's message nor arbitrary details are sent back or persisted.
function structureFeedback(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : error;
  const result = { code: safeCode(error?.code) ? error.code : 'item_contract_invalid' };
  if (safeField(details?.field)) result.field = details.field;
  for (const field of ['allowedIds', 'missingIds', 'duplicateIds']) {
    if (Array.isArray(details?.[field])) result[field] = [...new Set(details[field].filter(safeId))].slice(0, 200);
  }
  for (const field of ['unknownIdCount', 'receivedCount', 'expectedCount']) {
    if (Number.isSafeInteger(details?.[field]) && details[field] >= 0) result[field] = details[field];
  }
  if (typeof details?.arrayProvided === 'boolean') result.arrayProvided = details.arrayProvided;
  return result;
}

// One layer owns retries. The persisted in-flight input identifies the receipt
// to recover, including after an ambiguous provider failure.
// With components, scope identifies a stable logical review and dependencies(item)
// declares that component's complete material view. Physical batch membership is
// deliberately absent from the accepted-component identity. An already dispatched
// physical input is nevertheless immutable and must recover its original receipt.
export async function reviewItems({ judge, purpose, instructions, input, field, validateItem, pendingItem, maxTokens = 4500, components = null, prepareInput = null }) {
  const items = input[field];
  if (!Array.isArray(items) || items.some(item => typeof item?.id !== 'string') || new Set(items.map(item => item.id)).size !== items.length) throw new Error('EVALUATION_COMPONENT_IDS');
  if (components && (components.scope == null || typeof components.dependencies !== 'function')) throw new Error('EVALUATION_COMPONENT_DEPENDENCIES_REQUIRED');
  const policy = { version: JUDGE_VERSION, judge: judge.identity || {}, assessmentOrigin: judge.assessmentOrigin === 'scripted_fixture' ? 'scripted_fixture' : 'model_assessment', stage: judge.stage, purpose, instructions };
  const identity = hash(components ? { ...policy, componentCheckpointVersion: 1, scope: components.scope, field } : { ...policy, input, maxTokens });
  const file = judge.directory ? path.join(judge.directory, `${components ? 'components' : 'accepted'}-${identity}.json`) : null;
  let memory;
  if (components && !file) { memory = componentStates.get(judge); if (!memory) componentStates.set(judge, memory = new Map()); }
  const state = file && fs.existsSync(file) ? readJson(file) : memory?.get(identity) || { identity, accepted: {}, attempts: {}, failures: {}, queue: [], inflight: null };
  if (state.identity !== identity) throw new Error('EVALUATION_CHECKPOINT_IDENTITY');
  state.partials ||= {}; state.candidates ||= {}; state.errors ||= {}; state.records ||= {};
  const requested = items.map(item => {
    const dependencies = components ? components.dependencies(item) : null;
    if (components && dependencies === undefined) throw new Error('EVALUATION_COMPONENT_DEPENDENCIES_REQUIRED');
    const key = components ? hash({ item, dependencies }) : item.id;
    state.records[key] ||= globalThis.structuredClone({ item, dependencies });
    return { key, item };
  });
  const save = () => {
    try { if (file) writeJson(file, state); else if (memory) memory.set(identity, state); }
    catch (cause) { throw Object.assign(new Error('EVALUATION_CHECKPOINT_WRITE_FAILED', { cause }), { code: 'EVALUATION_CHECKPOINT_WRITE_FAILED' }); }
  };
  save();
  let blocked = false, blockedReason = null;
  while (!blocked) {
    if (!state.inflight) {
      // A rejected reservation may be retried using the current physical input.
      // Do this after every recovered flight as well as on initial entry: an
      // unrelated old flight must not strand the caller's undispatched items.
      if (components) for (const { key } of requested) if (state.failures[key] === 'budget_pending') delete state.failures[key];
      const remaining = requested.filter(({ key }) => !state.accepted[key] && (state.attempts[key] || 0) < 2
        && !['budget_pending', 'provider_pending'].includes(state.failures[key]));
      const batch = state.queue.length ? state.queue.shift().map(key => remaining.find(x => x.key === key)).filter(Boolean) : remaining;
      if (!batch.length) { if (state.queue.length) continue; break; }
      const batchItems = batch.map(x => x.item);
      // Only prepare a new request. A dispatched request must recover the exact
      // frozen payload, even if the current caller offers different context.
      const prepared = prepareInput ? prepareInput(globalThis.structuredClone(input), globalThis.structuredClone(batchItems)) : { ...input, [field]: batchItems };
      if (!prepared || hash(prepared[field]) !== hash(batchItems)) throw new Error('EVALUATION_PREPARED_ITEMS_CHANGED');
      state.inflight = { ids: batch.map(x => x.item.id), keys: batch.map(x => x.key), maxTokens, input: globalThis.structuredClone({ ...prepared,
        reviewAttempt: batch.map(({ key, item }) => ({ id: item.id, attempt: (state.attempts[key] || 0) + 1 })),
        repair: { codes: Object.fromEntries(batch.filter(x => state.failures[x.key]).map(x => [x.item.id, state.failures[x.key]])),
          errors: Object.fromEntries(batch.filter(x => state.errors[x.key]).map(x => [x.item.id, state.errors[x.key]])),
          acceptedCandidates: Object.fromEntries(batch.filter(x => state.partials[x.key]).map(x => [x.item.id, state.partials[x.key]])),
          candidates: Object.fromEntries(batch.filter(x => state.candidates[x.key]?.length).map(x => [x.item.id, state.candidates[x.key].map(({ fragmentId, catalogHash, quote, context }) => ({ fragmentId, catalogHash, quote, context }))])) } }), dispatched: false };
      save();
    }
    const flight = state.inflight;
    const keys = flight.keys || flight.ids;
    const onDispatch = () => {
      if (flight.dispatched) return;
      for (const key of keys) state.attempts[key] = (state.attempts[key] || 0) + 1;
      flight.dispatched = true; save();
    };
    try {
      if (!judge.supportsDispatch) onDispatch();
      const result = await judge.ask(purpose, instructions, flight.input,
        value => exactIds(value?.[field], flight.ids, 'id', `${field}.id`), flight.maxTokens ?? maxTokens, { maxAttempts: 1, onDispatch });
      exactIds(result?.[field], flight.ids, 'id', `${field}.id`);
      for (const value of result[field]) {
        const key = keys[flight.ids.indexOf(value.id)];
        if (state.accepted[key]) continue;
        try {
          validateItem(value, state.records[key]?.item || flight.input[field].find(item => item.id === value.id), {
            partial: state.partials[key], candidates: state.candidates[key] || [], dependencies: state.records[key]?.dependencies });
          state.accepted[key] = value; delete state.failures[key]; delete state.errors[key];
        } catch (error) {
          const feedback = structureFeedback(error); state.errors[key] = feedback; state.failures[key] = feedback.code;
          if (error.partial) state.partials[key] = error.partial;
          if (error.candidates?.length) state.candidates[key] = [...new Map([...(state.candidates[key] || []), ...error.candidates].map(c => [c.fragmentId, c])).values()];
        }
        // Each normalized sibling is durable even if interruption occurs before
        // the rest of this physical response has been validated.
        save();
      }
      state.inflight = null; save();
    } catch (error) {
      if (/^CALIBRATION_INPUTS_CHANGED/.test(error.message) || error.code === 'EVALUATION_CHECKPOINT_WRITE_FAILED') throw error;
      const budget = /BUDGET|WALL_CLOCK/.test(error.message), unknown = /UNKNOWN|PROVIDER_FAILED/.test(error.message);
      if (budget && !flight.dispatched && flight.ids.length > 1 && /BUDGET/.test(error.message)) {
        const middle = Math.ceil(flight.ids.length / 2);
        state.queue.unshift(keys.slice(0, middle), keys.slice(middle)); state.inflight = null; save(); continue;
      }
      for (const key of keys) if (!state.accepted[key]) {
        state.failures[key] = budget ? 'budget_pending' : unknown ? 'provider_pending' : 'structure_pending';
        if (!budget && !unknown && safeCode(error.code)) {
          const feedback = structureFeedback(error); state.errors[key] = feedback; state.failures[key] = feedback.code;
        }
      }
      if (!unknown) state.inflight = null;
      blocked = budget || unknown; blockedReason = budget ? 'budget_pending' : unknown ? 'provider_pending' : null; save();
    }
  }
  return requested.map(({ key, item }) => state.accepted[key] || pendingItem(item, state.failures[key] || blockedReason || 'review_pending', state.partials[key]));
}
