import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchRunner } from '../src/research/research-runner.mjs';
import { BudgetManager, wrapProvidersWithBudget } from '../src/research/budget-manager.mjs';
import { SearchProviderError } from '../src/search/search-provider-error.mjs';

test('failed first business search stops before any planner or report call', async () => {
  let searches = 0, plans = 0;
  const settings = { llm: {}, search: {}, research: { strategy: 'exploratory',
    exploratory: { minLlmTokens: 0, maxLlmTokens: 100000, maxSteps: 8 } } };
  await assert.rejects(new ResearchRunner().run({ query: 'Investigate Atlas', settings,
    search: { requiresReadinessProbe: true, async search() { searches++; throw new SearchProviderError('Unavailable'); } },
    llm: { async complete() { plans++; throw new Error('Planner should not run'); } },
  }), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
  assert.equal(searches, 1);
  assert.equal(plans, 0);
});

test('three consecutive provider failures open the circuit without another dispatched request', async () => {
  let calls = 0;
  const budget = new BudgetManager({}); budget.executionVersion = 2;
  const { search } = wrapProvidersWithBudget({ llm: {}, budget,
    search: { async search() { calls++; throw new SearchProviderError('Disconnected'); } } });
  await assert.rejects(search.search('one'));
  await assert.rejects(search.search('two'));
  await assert.rejects(search.search('three'), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
  await assert.rejects(search.search('four'), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
  assert.equal(calls, 3);
  assert.equal(budget.usage.searchRequests, 3);
});

test('a valid empty response resets failures and remains a successful provider response', async () => {
  let calls = 0;
  const budget = new BudgetManager({}); budget.executionVersion = 2;
  const { search } = wrapProvidersWithBudget({ llm: {}, budget, search: { async search() {
    calls++; if (calls === 3) return []; throw new SearchProviderError('Disconnected');
  } } });
  await assert.rejects(search.search('one')); await assert.rejects(search.search('two'));
  assert.deepEqual(await search.search('empty'), []);
  await assert.rejects(search.search('four'), { code: 'provider_error' });
  assert.equal(calls, 4);
});

test('a mid-run provider outage stops planning and never becomes a terminal research result', async () => {
  const { canonicalLlm } = await import('./helpers/canonical-llm.mjs');
  let calls = 0, failedCalls = 0;
  const events = [];
  const llm = canonicalLlm({ onCall: args => events.push({ purpose: args.purpose, failedCalls }) });
  const settings = { llm: {}, search: {}, research: { strategy: 'exploratory',
    exploratory: { minLlmTokens: 0, maxLlmTokens: 100000, maxSteps: 64, autoReadTopK: 0 },
    focused: { fetchMode: 'disabled', evidencePassages: { embedding: { enabled: false } } } } };
  await assert.rejects(new ResearchRunner().run({ query: 'Investigate Atlas', settings, llm,
    search: { requiresReadinessProbe: true, async search() {
      calls++; if (calls === 1) return [];
      failedCalls++; throw new SearchProviderError('Disconnected', { code: 'connection_closed', phase: 'response' });
    } },
  }), { code: 'SEARCH_PROVIDER_UNAVAILABLE' });
  assert.equal(failedCalls, 3);
  assert.ok(events.every(e => e.failedCalls < 3));
  assert.ok(!events.some(e => e.purpose === 'report'));
});
