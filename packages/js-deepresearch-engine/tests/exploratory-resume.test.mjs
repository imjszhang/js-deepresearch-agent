import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetManager } from '../src/research/budget-manager.mjs';
import { QueryMemory } from '../src/research/query-memory.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { runExploratoryLoop } from '../src/research/strategies/exploratory-loop.mjs';
import { resolveRecoveryAction } from '../src/research/strategies/exploratory-loop.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

function settings() {
  return {
    research: {
      strategy: 'exploratory',
      exploratory: {
        minLlmTokens: 0,
        maxLlmTokens: 0,
        maxSteps: 4,
        maxRepairFailuresPerGap: 3,
        maxConsecutiveInvalidSteps: 6,
      },
      budget: {},
      read: { fetchMode: 'disabled', relevance: { enabled: false } },
    },
    search: { engine: 'local' },
    llm: { maxTokens: 50 },
  };
}

describe('exploratory loop resume', () => {
  it('restores loopLocal and continues from the next step without re-planning the contract', async () => {
    const budget = new BudgetManager(settings(), () => {});
    budget.usage.llmTokens = 40;
    budget.usage.searchRequests = 2;
    const queryMemory = new QueryMemory({ enabled: true });
    queryMemory.record({ query: 'alpha', gapId: 'gap-1', provider: 'test', status: 'useful', results: [] });
    const state = new ResearchState({
      query: 'Qwen hardware on qwenlm.github.io',
      maxSteps: 2,
      budget,
      brief: {
        query: 'Qwen hardware on qwenlm.github.io',
        requiredAnswerSlots: [{ id: 'hw', question: 'official hardware', requiredHosts: ['qwenlm.github.io'] }],
      },
    });
    state.step = 2;
    state.observedHosts.add('github.com');
    state.gaps = [{
      id: 'gap-1',
      question: 'official hardware',
      requiredSlot: true,
      requiredHosts: ['qwenlm.github.io'],
      status: 'open',
      searchedQueries: ['Qwen hardware'],
    }];
    const checkpoint = state.exportCheckpoint({
      queryMemory,
      loopLocal: {
        consecutiveInvalidSteps: 2,
        stopReason: null,
        stopDetail: null,
      },
    });

    const purposes = [];
    const llm = {
      async complete({ purpose, messages }) {
        purposes.push(purpose);
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') {
          throw new Error('resume at the step cap must not decide a new action');
        }
        if (purpose === 'research_profile') {
          throw new Error('resume must not re-infer the research profile');
        }
        return '# Report\n\n## Summary\n\nResumed without a new contract.';
      },
    };
    const findings = await runExploratoryLoop({
      query: 'Qwen hardware on qwenlm.github.io',
      llm,
      search: { async search() { return []; } },
      emit: () => {},
      settings: settings(),
      budget: new BudgetManager(settings(), () => {}),
      queryMemory: new QueryMemory({ enabled: true }),
      trace: [],
      recorder: { checkpoint() {}, event() {} },
      restoredCheckpoint: checkpoint,
    });
    assert.ok(!purposes.includes('research_profile'));
    assert.ok(findings.exploratoryLoop);
    assert.ok(findings.exploratoryLoop.gaps.some((gap) => gap.id === 'gap-1'));
  });

  it('does not re-enter the loop when a restored checkpoint already stopped', async () => {
    const budget = new BudgetManager(settings(), () => {});
    const state = new ResearchState({
      query: 'Qwen hardware on qwenlm.github.io',
      maxSteps: 0,
      budget,
      brief: { query: 'Qwen hardware on qwenlm.github.io' },
    });
    state.step = 4;
    state.gaps = [{
      id: 'gap-1',
      question: 'official hardware',
      requiredSlot: true,
      requiredHosts: ['qwenlm.github.io'],
      status: 'open',
    }];
    const checkpoint = state.exportCheckpoint({
      loopLocal: {
        stopReason: 'safety_cap',
        stopDetail: 'query_planner_exhausted',
        consecutiveInvalidSteps: 6,
      },
    });
    const llm = {
      async complete({ purpose }) {
        throw new Error(`must not call ${purpose} after a terminal restore`);
      },
    };
    const findings = await runExploratoryLoop({
      query: 'Qwen hardware on qwenlm.github.io',
      llm,
      search: { async search() { throw new Error('must not search after a terminal restore'); } },
      emit: () => {},
      settings: settings(),
      budget: new BudgetManager(settings(), () => {}),
      queryMemory: new QueryMemory({ enabled: true }),
      trace: [],
      recorder: { checkpoint() {}, event() {} },
      restoredCheckpoint: checkpoint,
    });
    assert.equal(findings.exploratoryLoop.stopReason, 'safety_cap');
    assert.equal(findings.exploratoryLoop.stopDetail, 'query_planner_exhausted');
  });

  it('asks the planner for site: recovery on a never-retrieved literal host', async () => {
    const state = new ResearchState({
      query: 'Qwen hardware on qwenlm.github.io',
      brief: { query: 'Qwen hardware on qwenlm.github.io' },
    });
    state.gaps = [{
      id: 'gap-1',
      question: 'official hardware',
      requiredSlot: true,
      requiredHosts: ['qwenlm.github.io'],
      status: 'open',
      searchedQueries: ['Qwen hardware github'],
    }];
    const llm = {
      async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        throw new Error(`unexpected ${purpose}`);
      },
    };
    const action = await resolveRecoveryAction(state, {
      llm,
      maxQueriesPerStep: 1,
    });
    assert.equal(action.plannerMode, 'required_host_recovery');
    assert.match(action.query, /site:qwenlm\.github\.io/i);
  });

  it('unlocks planner terminals and issues required_host_recovery when continue-explore is set', async () => {
    const budget = new BudgetManager(settings(), () => {});
    const state = new ResearchState({
      query: 'Qwen hardware on qwenlm.github.io',
      maxSteps: 3,
      budget,
      brief: { query: 'Qwen hardware on qwenlm.github.io' },
    });
    state.step = 3;
    state.gaps = [{
      id: 'gap-1',
      question: 'official hardware',
      requiredSlot: true,
      requiredHosts: ['qwenlm.github.io'],
      status: 'open',
      searchedQueries: ['Qwen hardware github'],
    }];
    state.markRepairTerminal('gap-1', 'query_planner_exhausted', { phase: 'planner' });
    const checkpoint = state.exportCheckpoint({
      loopLocal: {
        stopReason: 'safety_cap',
        stopDetail: 'query_planner_exhausted',
        consecutiveInvalidSteps: 6,
      },
    });
    const modes = [];
    const searches = [];
    const llm = {
      async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') {
          const user = JSON.parse(messages.find((item) => item.role === 'user')?.content || '{}');
          modes.push(user.mode);
          return defaultSearchQueryPlan(messages);
        }
        if (purpose === 'agent_decision') {
          return JSON.stringify({ action: 'search', gapId: 'gap-1', plannerMode: 'repair' });
        }
        if (purpose === 'research_profile') {
          throw new Error('continue-explore must not re-infer the profile');
        }
        return '# Report\n\n## Summary\n\nContinue explore issued host recovery.';
      },
    };
    await runExploratoryLoop({
      query: 'Qwen hardware on qwenlm.github.io',
      llm,
      search: {
        async search(query) {
          searches.push(query);
          return [];
        },
      },
      emit: () => {},
      settings: settings(),
      budget: new BudgetManager(settings(), () => {}),
      queryMemory: new QueryMemory({ enabled: true }),
      trace: [],
      recorder: { checkpoint() {}, event() {} },
      restoredCheckpoint: checkpoint,
      continueExplore: true,
      extraSteps: 1,
    });
    assert.ok(modes.includes('required_host_recovery'));
    assert.ok(searches.some((query) => /site:qwenlm\.github\.io/i.test(query)));
  });
});
