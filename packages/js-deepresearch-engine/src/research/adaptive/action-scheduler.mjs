import { createHash } from 'node:crypto';

const TYPES = new Set(['search', 'read_candidate', 'inspect_document', 'check_conflict']);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function actionKey(action) {
  return `action-${digest([action.type, action.targetTaskIds, action.inputRefs,
    [...(action.evidenceDependencies || [])].sort(), action.constraintRevision || 1])}`;
}

export class ActionScheduler {
  constructor(snapshot = null, { capacity = 8, maxFailures = 3 } = {}) {
    this.capacity = capacity;
    this.maxFailures = maxFailures;
    this.actions = new Map();
    this.receipts = new Map();
    this.appliedReceiptIds = new Set();
    this.plannerFailures = new Map();
    this.round = 0;
    this.taskTurns = new Map();
    this.planningTurns = new Map();
    this.noChangeCycles = 0;
    this.surveyTaskIds = [];
    this.cycleStart = null;
    this.terminal = null;
    this.segments = [];
    if (snapshot) this.restore(snapshot);
  }

  enqueue(spec) {
    if (!TYPES.has(spec.type)) throw new TypeError('Invalid research action.');
    const actionId = actionKey(spec);
    if (this.actions.has(actionId) || [...this.actions.values()].filter((action) => action.status === 'pending').length >= this.capacity) return null;
    const action = { ...globalThis.structuredClone(spec), actionId, status: 'pending', attemptCount: 0, queuedAtRound: this.round, nextEligibleAt: 0 };
    this.actions.set(actionId, action);
    return action;
  }

  next({ canRun = () => true, now = Date.now() } = {}) {
    if (this.terminal) return null;
    const localRank = { inspect_document: 0, check_conflict: 1, read_candidate: 2, search: 3 };
    const candidates = [...this.actions.values()].filter((action) => action.status === 'pending' && action.nextEligibleAt <= now && canRun(action));
    candidates.sort((a, b) => Number(b.required) - Number(a.required)
      || (this.taskTurns.get(a.targetTaskIds[0]) || 0) - (this.taskTurns.get(b.targetTaskIds[0]) || 0)
      || localRank[a.type] - localRank[b.type]
      || Number(a.relevance === 'uncertain') - Number(b.relevance === 'uncertain')
      || a.queuedAtRound - b.queuedAtRound);
    return candidates[0] || null;
  }

  begin(action) {
    if (this.terminal || action.status !== 'pending') throw new Error('Action cannot be dispatched.');
    action.status = 'running'; action.attemptCount += 1;
    action.attemptId = `${action.actionId}-attempt-${action.attemptCount}`;
    this.round += 1;
    this.taskTurns.set(action.targetTaskIds[0], this.round);
    return action.attemptId;
  }

  receipt(action, outcome) {
    const receiptId = `${action.attemptId}-receipt`;
    if (this.receipts.has(receiptId)) return this.receipts.get(receiptId);
    const receipt = { receiptId, actionId: action.actionId, attemptId: action.attemptId, outcome: globalThis.structuredClone(outcome) };
    this.receipts.set(receiptId, receipt);
    action.receiptRef = receiptId;
    return receipt;
  }

  apply(receipt) {
    if (this.appliedReceiptIds.has(receipt.receiptId)) return false;
    const action = this.actions.get(receipt.actionId);
    if (!action || action.attemptId !== receipt.attemptId) throw new Error('Receipt attempt mismatch.');
    const outcome = receipt.outcome;
    action.status = outcome.execution === 'succeeded' ? 'completed' : outcome.execution || 'failed';
    if (outcome.retryable && action.attemptCount < this.maxFailures && !this.terminal) {
      action.status = 'pending';
      action.nextEligibleAt = Date.now() + Math.max(0, outcome.retryAfterMs || 0);
    }
    this.appliedReceiptIds.add(receipt.receiptId);
    return true;
  }

  plannerKey(taskId, dependencies = []) { return digest([taskId, [...dependencies].sort()]); }
  notePlannerFailure(taskId, dependencies = []) {
    const key = this.plannerKey(taskId, dependencies);
    this.plannerFailures.set(key, (this.plannerFailures.get(key) || 0) + 1);
  }
  canPlan(taskId, dependencies = []) { return (this.plannerFailures.get(this.plannerKey(taskId, dependencies)) || 0) < this.maxFailures; }
  stop(reason, detail) { this.terminal ||= { reason, detail, round: this.round }; }
  continueSegment() {
    if (this.terminal) this.segments.push(this.terminal);
    this.terminal = null;
  }
  recover() {
    for (const receipt of this.receipts.values()) this.apply(receipt);
    for (const action of this.actions.values()) if (action.status === 'running') action.status = 'outcome_unknown';
  }
  export() {
    return { schemaVersion: 1, capacity: this.capacity, maxFailures: this.maxFailures, actions: [...this.actions.values()], receipts: [...this.receipts.values()],
      appliedReceiptIds: [...this.appliedReceiptIds], plannerFailures: [...this.plannerFailures], taskTurns: [...this.taskTurns],
      planningTurns: [...this.planningTurns], noChangeCycles: this.noChangeCycles, surveyTaskIds: this.surveyTaskIds, cycleStart: this.cycleStart,
      round: this.round, terminal: this.terminal, segments: this.segments };
  }
  restore(snapshot) {
    if (snapshot.schemaVersion !== 1) throw new Error('Unsupported scheduler schema.');
    this.capacity = Math.max(1, Number(snapshot.capacity) || this.capacity);
    this.maxFailures = Math.max(1, Number(snapshot.maxFailures) || this.maxFailures);
    this.actions = new Map(snapshot.actions.map((item) => [item.actionId, item]));
    this.receipts = new Map(snapshot.receipts.map((item) => [item.receiptId, item]));
    this.appliedReceiptIds = new Set(snapshot.appliedReceiptIds);
    this.plannerFailures = new Map(snapshot.plannerFailures);
    this.taskTurns = new Map(snapshot.taskTurns || []);
    this.planningTurns = new Map(snapshot.planningTurns || []);
    this.noChangeCycles = snapshot.noChangeCycles || 0;
    this.surveyTaskIds = snapshot.surveyTaskIds || [];
    this.cycleStart = snapshot.cycleStart || null;
    this.round = snapshot.round || 0;
    this.terminal = snapshot.terminal;
    this.segments = snapshot.segments || [];
  }
}
