import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionScheduler } from '../src/research/adaptive/action-scheduler.mjs';
import { BudgetManager } from '../src/research/budget-manager.mjs';
import { searchRequestKey, QueryMemory } from '../src/research/query-memory.mjs';
import { validatePlannedQuery } from '../src/research/search-query-planner.mjs';

test('three uncertain queries dispatch from one queue and receipts apply exactly once', () => {
  const scheduler = new ActionScheduler();
  for (const query of ['first', 'second', 'third']) scheduler.enqueue({ type: 'search', targetTaskIds: ['a'], inputRefs: { query }, relevance: 'uncertain' });
  for (let index = 0; index < 3; index++) {
    const action = scheduler.next(); assert.ok(action);
    scheduler.begin(action);
    const receipt = scheduler.receipt(action, { execution: 'succeeded' });
    const restored = new ActionScheduler(JSON.parse(JSON.stringify(scheduler.export())));
    restored.recover();
    assert.equal(restored.apply(receipt), false);
    scheduler.apply(receipt);
  }
  assert.equal(scheduler.next(), null);
});

test('local planner failure does not seal other tasks or reopen on unrelated evidence', () => {
  const scheduler = new ActionScheduler();
  for (let index = 0; index < 3; index++) scheduler.notePlannerFailure('a', ['doc-a']);
  assert.equal(scheduler.canPlan('a', ['doc-a']), false);
  assert.equal(scheduler.canPlan('b', ['doc-b']), true);
  assert.equal(scheduler.canPlan('a', ['doc-a-new']), true);
  const action = scheduler.enqueue({ type: 'search', targetTaskIds: ['b'], inputRefs: { query: 'tool usage' } });
  scheduler.begin(action);
  scheduler.stop('safety_cap', 'no_state_change');
  const receipt = scheduler.receipt(action, { execution: 'failed', retryable: true });
  scheduler.apply(receipt);
  const restored = new ActionScheduler(scheduler.export()); restored.recover();
  assert.equal(restored.next(), null);
  assert.equal(restored.terminal.reason, 'safety_cap');
  restored.continueSegment();
  assert.equal(restored.segments[0].reason, 'safety_cap');
});

test('unknown attempt reservation survives recovery and bounded retry reserves additional budget', () => {
  const budget = new BudgetManager({ research: { budget: { maxLlmTokens: 100 }, exploratory: { minLlmTokens: 60 } } });
  budget.executionVersion = 2;
  budget.reserveAttempt('attempt-1', 60, { purpose: 'search_query_planning' });
  budget.settleAttempt('attempt-1', null);
  const restored = new BudgetManager().restoreCheckpoint(budget.exportCheckpoint());
  assert.equal(restored.canClaim('llmTokens', 41), false);
  assert.equal(restored.snapshot().floorStatus, 'unknown');
  restored.reserveAttempt('attempt-2', 30, { purpose: 'search_query_planning' });
  restored.settleAttempt('attempt-2', { totalTokens: 10 });
  assert.equal(restored.settleAttempt('attempt-2', { totalTokens: 10 }), false);
  assert.equal(restored.usage.llmTokens, 10);
  assert.equal(restored.reservedTokens(), 60);
});

test('confirmed usage can prove the floor while unknown attempts still reserve the ceiling', () => {
  const budget = new BudgetManager({ research: { budget: { maxLlmTokens: 100 }, exploratory: { minLlmTokens: 60 } } });
  budget.executionVersion = 2;
  budget.reserveAttempt('unknown', 10, { purpose: 'gap_support' });
  budget.settleAttempt('unknown', null);
  assert.equal(budget.snapshot().floorStatus, 'unknown');
  budget.reserveAttempt('known', 60, { purpose: 'gap_support' });
  budget.settleAttempt('known', { totalTokens: 60 });
  const restored = new BudgetManager().restoreCheckpoint(budget.exportCheckpoint());
  assert.equal(restored.snapshot().floorStatus, 'met');
  assert.equal(restored.snapshot().floorShortfallTokens, 0);
  assert.ok(restored.snapshot().unknown.explorationTokens > 0);
  assert.equal(restored.reservedTokens(), 10);
  assert.equal(restored.canClaim('llmTokens', 31), false);
});

test('query admission allows uncertain cross-language scope while exact search identity respects parameters', () => {
  assert.equal(validatePlannedQuery('Tool license terms', { gap: { id: 'gap-2', question: '产品如何授权' }, softScope: true }).ok, true);
  assert.equal(validatePlannedQuery('site:unknown.example.org tool', { gap: { id: 'gap-2' }, softScope: true }).ok, false);
  assert.notEqual(searchRequestKey('"tool license"', 'google'), searchRequestKey('tool license', 'google'));
  assert.notEqual(searchRequestKey('tool', 'google', { language: 'en' }), searchRequestKey('tool', 'google', { language: 'zh' }));
  const memory = new QueryMemory();
  memory.recordExecuted('tool', 'google', { language: 'en' }, [{ url: 'https://example.org' }]);
  assert.equal(memory.getExecuted('tool', 'google', { language: 'en' }).results.length, 1);
  assert.equal(memory.getExecuted('tool', 'google', { language: 'zh' }), null);
});

test('budget admission rejection does not count a provider request or create a reservation', async () => {
  const { wrapProvidersWithBudget } = await import('../src/research/budget-manager.mjs');
  const budget = new BudgetManager({ research: { budget: { maxLlmTokens: 10 } } });
  budget.executionVersion = 2;
  const wrapped = wrapProvidersWithBudget({ budget, search: {}, llm: { async complete() { assert.fail('Rejected work must not reach the provider'); } } });
  await assert.rejects(wrapped.llm.complete({ purpose: 'gap_support', maxTokens: 20, messages: [] }), { name: 'BudgetExceededError' });
  assert.equal(budget.usage.llmRequests, 0);
  assert.equal(budget.reservations.size, 0);
});
