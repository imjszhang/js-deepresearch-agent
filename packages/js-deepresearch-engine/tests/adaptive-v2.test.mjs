import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { buildAngleChangeSearch, fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

function report() {
  return '# Research Report\n\n## Summary\n\nThe selected source provides enough evidence to answer the requested topic while keeping the agent source choice visible. [1.1]\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]';
}

function defaultContractProfile(extra = {}) {
  return JSON.stringify({
    requiredAnswerSlots: [{ answerSlot: 'topic', question: 'topic evidence', priority: 'normal' }],
    minIndependentSources: 1,
    ...extra,
  });
}

function defaultGapSupport(messages) {
  const text = (messages || []).map((item) => item.content).join('\n');
  const gapIds = [...new Set([...text.matchAll(/gapId:\s+(gap-\S+)/g)].map((match) => match[1]))];
  const quote = (text.match(/\] ([^\n]+)/) || [])[1] || '';
  return JSON.stringify({
    judgments: (gapIds.length ? gapIds : ['gap-2']).map((gapId) => ({
      gapId,
      verdict: quote.length >= 12 ? 'supported' : 'unverifiable',
      quote,
      reason: 'test default support',
    })),
  });
}

function llmFor(decisions, {
  onEvaluation = () => report(),
  onDecompose = () => 'no json here',
  onProfile = () => defaultContractProfile(),
  onGapSupport = defaultGapSupport,
} = {}) {
  return {
    async complete({ purpose, messages }) {
      if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
      if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
      if (purpose === 'answer_evaluation') return onEvaluation();
      if (purpose === 'gap_decomposition') return onDecompose();
      if (purpose === 'research_profile') return onProfile();
      if (purpose === 'gap_support') return onGapSupport(messages);
      if (purpose === 'source_assessment') {
        return JSON.stringify({
          summary: 'Selected source provides enough evidence for the requested topic.',
          readability: 'readable',
          contentKind: 'article',
          publisherType: 'official',
          firstParty: true,
          evidenceTier: 'other_primary',
          reason: 'test assessment',
        });
      }
      return report();
    },
  };
}

function keepExploringProfile() {
  return defaultContractProfile({ minIndependentSources: 2 });
}

describe('exploratory agent loop', () => {
  it('enforces action preconditions without encoding research policy', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 3 });
    assert.equal(state.validate({ action: 'read', sourceIds: ['missing'] }), 'unknown_source');
    assert.equal(state.validate({ action: 'search' }), 'missing_query');
    assert.equal(state.validate({ action: 'answer' }), 'no_evidence');
  });

  it('gates repeated actions and answering right after a search', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://a.test', title: 'A' }], 'gap-1');
    state.lastAction = 'search';
    state.observations.push({ type: 'search_result', query: 'topic', resultCount: 1 });
    assert.equal(state.validate({ action: 'search', query: 'topic' }), 'repeat_action');
    assert.equal(state.validate({ action: 'search', query: 'another query' }), null);
    assert.equal(state.validate({ action: 'answer' }), 'answer_after_search');
    assert.equal(state.validate({ action: 'read', sourceIds: ['https://a.test'] }), null);

    // A search that returned zero results may be retried with a new query.
    state.observations.push({ type: 'search_result', query: 'empty query', resultCount: 0 });
    assert.equal(state.validate({ action: 'search', query: 'different query' }), null);
  });

  it('accumulates freq, caps candidates per hostname and exposes knowledge in snapshots', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://dup.test/one', title: 'One' }], 'gap-1');
    state.addCandidates([
      { url: 'https://dup.test/one', title: 'One' },
      { url: 'https://dup.test/two', title: 'Two' },
      { url: 'https://dup.test/three', title: 'Three' },
      { url: 'https://other.test/page', title: 'Other' },
    ], 'gap-1');
    state.observations.push({ type: 'search_result', query: 'topic query', resultCount: 4 });
    state.addKnowledge({ gapId: 'gap-1', sourceId: 'https://dup.test/one', learned: 'x'.repeat(500) });

    assert.equal(state.candidates.get('https://dup.test/one').freq, 2);
    const snapshot = state.snapshot();
    assert.equal(snapshot.candidates.filter((candidate) => candidate.id.startsWith('https://dup.test')).length, 2);
    assert.equal(snapshot.candidates[0].id, 'https://dup.test/one');
    assert.deepEqual(snapshot.searchedQueries, ['topic query']);
    assert.equal(snapshot.knowledge.length, 1);
    assert.equal(snapshot.knowledge[0].learned.length, 160);
    assert.equal(snapshot.stepsRemaining, 10);
  });

  it('exposes a slim top-8 candidate list plus diary instead of raw observations', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    const sources = Array.from({ length: 12 }, (_, index) => ({ url: `https://host${index}.test/page`, title: `T${index}`, snippet: 'long snippet text' }));
    state.addCandidates(sources, 'gap-1');
    state.readSourceIds.add('https://host0.test/page');
    state.observations.push({ type: 'search_result', query: 'topic', resultCount: 12 });
    for (let line = 0; line < 15; line += 1) state.addDiary(`event ${line}`);

    const snapshot = state.snapshot();
    assert.equal(snapshot.candidates.length, 8);
    assert.deepEqual(Object.keys(snapshot.candidates[0]).sort(), ['gapId', 'id', 'read', 'score', 'title']);
    assert.equal(snapshot.candidates.find((candidate) => candidate.id === 'https://host0.test/page').read, true);
    assert.equal(snapshot.diary.length, 12);
    assert.ok(snapshot.diary.at(-1).includes('event 14'));
    assert.ok(!('recentObservations' in snapshot));
    assert.ok(!('readSourceIds' in snapshot));

    state.recordSearchOutcome({
      query: 'topic',
      sources: sources.slice(0, 1),
      resultCount: 1,
    });
    const agent = state.snapshotForAgent();
    assert.ok(!('brief' in agent));
    assert.ok(!('sufficiency' in agent));
    assert.ok(!('qualityGate' in agent));
    assert.equal(agent.recentSearchOutcomes.length, 1);
    assert.ok(agent.unreadCandidates.length <= 8);
    assert.ok(JSON.stringify(agent).length < JSON.stringify(snapshot).length);
  });

  it('fallback read prefers ranked candidates from unread hostnames over SERP order', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([
      { url: 'https://read.test/page', title: 'Already read' },
      { url: 'https://read.test/other', title: 'Same host as read' },
      { url: 'https://low.test/page', title: 'Low score' },
      { url: 'https://high.test/page', title: 'High score' },
    ], 'gap-1');
    state.readSourceIds.add('https://read.test/page');
    state.candidates.get('https://read.test/other').rerank = { score: 0.95 };
    state.candidates.get('https://high.test/page').rerank = { score: 0.9 };
    state.candidates.get('https://low.test/page').rerank = { score: 0.2 };

    const action = fallbackAdaptiveAction(state);
    assert.equal(action.action, 'read');
    assert.deepEqual(action.sourceIds, ['https://high.test/page', 'https://low.test/page']);
  });

  it('ranks boosted hostnames above penalized download portals', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([
      { url: 'https://www.techspot.com/downloads/tool.html', title: 'Download portal' },
      { url: 'https://github.com/org/project', title: 'Official repo' },
      { url: 'https://example.com/blog', title: 'Neutral blog' },
    ], 'gap-1');
    const ranked = state.rankedCandidates().map((candidate) => candidate.url);
    assert.equal(ranked[0], 'https://github.com/org/project');
    assert.equal(ranked[2], 'https://www.techspot.com/downloads/tool.html');
  });

  it('rotates focusGapId across open gaps and marks covered gaps', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addGap('sub-question two');
    state.addGap('sub-question three');
    const focusAtStep = [];
    for (let step = 0; step < 3; step += 1) {
      state.step = step;
      focusAtStep.push(state.focusGap().id);
    }
    assert.deepEqual([...new Set(focusAtStep)].sort(), ['gap-1', 'gap-2', 'gap-3']);

    state.findings.push({
      gapId: 'gap-2',
      sources: [{ url: 'https://x.test', fetchStatus: 'ok', content: 'Sub-question two has a successful body with enough detail.' }],
    });
    const snapshot = state.snapshot();
    assert.equal(snapshot.gaps.find((gap) => gap.id === 'gap-2').covered, true);
    assert.equal(snapshot.gaps.find((gap) => gap.id === 'gap-1').covered, false);
    assert.ok(snapshot.focusGapId);
  });

  it('falls back to an angle-change search instead of reflect when the gate failed', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://done.test/page', title: 'Done' }], 'gap-1');
    state.readSourceIds.add('https://done.test/page');
    state.lastAction = 'search';
    const action = fallbackAdaptiveAction(state, { belowHardCap: true, readiness: { pass: false } });
    assert.equal(action.action, 'search');
    assert.notEqual(action.action, 'reflect');
    assert.equal(action.reasonCode, 'fallback_slot_repair');
  });

  it('does not append step numbers when search angles are exhausted', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://done.test/page', title: 'Done' }], 'gap-1');
    state.readSourceIds.add('https://done.test/page');
    state.recordSearchedQuery('gap-1', 'topic');
    state.lastAction = 'search';
    const action = fallbackAdaptiveAction(state, { belowHardCap: true, readiness: { pass: false } });
    assert.equal(action.action, 'search');
    assert.equal(action.reasonCode, 'fallback_slot_repair');
    assert.equal(action.needsPlanner, true);
    assert.ok(!action.query);
    const redirected = buildAngleChangeSearch(state);
    assert.equal(redirected.plannerMode, 'angle_change');
    assert.ok(!/\s+\d+(-\d+)?$/.test(action.query || ''));
  });

  it('skips site: fallbacks for local-only evidence scope', () => {
    const state = new ResearchState({
      query: '房产操作攻略',
      evidenceScope: 'local',
      profile: {
        flags: {},
        requiredHosts: ['fang.com'],
        preferredHosts: [],
        requiredSourceTypes: [],
        minIndependentSources: 1,
        evidenceScope: 'local',
      },
    });
    const action = buildAngleChangeSearch(state);
    assert.ok(action);
    assert.equal(action.needsPlanner, true);
    assert.equal(action.plannerMode, 'angle_change');
    assert.ok(!String(action.query || '').includes('site:'));
    assert.ok(!(action.queries || []).some((query) => query.includes('site:')));
  });

  it('falls back to answer when the gate already passed and unread sources are gone', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://done.test/page', title: 'Done' }], 'gap-1');
    state.readSourceIds.add('https://done.test/page');
    state.lastAction = 'search';
    const action = fallbackAdaptiveAction(state, { belowMin: false, readiness: { pass: true } });
    assert.equal(action.action, 'answer');
    assert.equal(action.reasonCode, 'fallback_evidence_sufficient');
  });

  it('lets the agent read a non-top rerank candidate and works without embeddings', async () => {
    const decisions = [
      { action: 'search', query: 'agent loop architecture', gapId: 'gap-1', reasonCode: 'find_sources' },
      { action: 'read', sourceIds: ['https://second.test'], gapId: 'gap-1', reasonCode: 'inspect_alternative' },
      { action: 'answer', reasonCode: 'evidence_sufficient' },
    ];
    const result = await new ResearchRunner().run({
      query: 'agent loop architecture',
      settings: {
        llm: {}, search: {},
        research: {
          strategy: 'exploratory',
          exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 5, maxEvaluationRetries: 0, autoReadTopK: 0 },
          providers: { embedding: { provider: 'disabled' }, rerank: { provider: 'rules' } },
          focused: { fetchMode: 'disabled', evidencePassages: { enabled: true, claimAlignment: true } },
          budget: { maxSearchRequests: 3, maxSourceReads: 0, maxLlmTokens: 0 },
        },
      },
      search: { async search() { return [
        { title: 'Agent loop architecture', url: 'https://top.test', snippet: 'agent loop architecture details', content: 'Top source evidence.', fetchStatus: 'ok' },
        { title: 'Alternative', url: 'https://second.test', snippet: 'different perspective', content: 'The selected source provides evidence for the requested topic and preserves agent source choice.', fetchStatus: 'ok' },
      ]; } },
      llm: llmFor(decisions),
    });

    const read = result.trace.find((entry) => entry.action === 'read');
    assert.deepEqual(read.sourceIds, ['https://second.test']);
    assert.equal(result.findings[0].sources[0].url, 'https://second.test');
    assert.equal(result.quality.budget.usage.rerankRequests, 0);
  });

  it('rejects an invalid model action and falls back safely', async () => {
    const decisions = [
      { action: 'read', sourceIds: ['missing'], reasonCode: 'bad_choice' },
      { action: 'read', sourceIds: ['https://source.test'], reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'fallback topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 5, maxEvaluationRetries: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'S', url: 'https://source.test', content: 'Fallback topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'unknown_source'));
    assert.ok(result.trace.some((entry) => entry.action === 'search'));
  });

  it('rejects a repeated action and falls back to reading gathered evidence', async () => {
    const decisions = [
      { action: 'search', query: 'gated topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'search', query: 'gated topic', gapId: 'gap-1', reasonCode: 'search_again' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'gated topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'G', url: 'https://gated.test', content: 'Gated topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => (
      entry.action === 'read'
      && ['fallback_read_evidence', 'slot_repair_read'].includes(entry.reasonCode)
    )));
    assert.ok(result.quality.budget.usage.searchRequests >= 1);
  });

  it('rejects a duplicate query without consuming search budget', async () => {
    const decisions = [
      { action: 'search', query: 'duplicate query topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://dupquery.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'search', query: 'duplicate query topic', gapId: 'gap-1', reasonCode: 'search_same' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'duplicate query topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 0, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'D', url: 'https://dupquery.test', content: 'Duplicate query topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions, { onProfile: keepExploringProfile }),
    });
    const sameQuerySearches = result.trace.filter((entry) => (
      entry.action === 'search'
      && entry.decisionStep
      && !['rejected', 'skipped', 'filtered'].includes(entry.status)
      && (entry.query === 'duplicate query topic' || (entry.queries || []).includes('duplicate query topic'))
    ));
    assert.ok(sameQuerySearches.length <= 1);
    assert.ok(result.trace.some((entry) => (
      entry.status === 'rejected'
      && ['duplicate_query', 'missing_query'].includes(entry.reasonCode)
    )) || result.trace.some((entry) => entry.action === 'search_query_planned' && entry.failure));
    assert.ok(result.quality.budget.usage.searchRequests >= 1);
  });

  it('allows one evidence-driven improvement cycle before answering', async () => {
    const searches = [
      [{ title: 'Snippet only', url: 'https://snippet.test', snippet: 'only a snippet' }],
      [{ title: 'Quality', url: 'https://quality.test', content: 'The selected source provides evidence for the requested topic and preserves agent source choice.', fetchStatus: 'ok' }],
    ];
    const decisions = [
      { action: 'search', query: 'quality topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://snippet.test'], gapId: 'gap-1', reasonCode: 'read_snippet' },
      { action: 'answer', reasonCode: 'premature' },
      { action: 'search', query: 'quality topic direct evidence', gapId: 'gap-1', reasonCode: 'search_more' },
      { action: 'read', sourceIds: ['https://quality.test'], gapId: 'gap-1', reasonCode: 'improve_evidence' },
      { action: 'answer', reasonCode: 'supported' },
    ];
    const result = await new ResearchRunner().run({
      query: 'quality topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 1, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return searches.shift() || []; } },
      llm: llmFor(decisions, { onProfile: keepExploringProfile }),
    });
    assert.ok(!result.trace.some((entry) => (
      entry.action === 'answer' && entry.reasonCode === 'premature' && entry.status === 'success'
    )));
    assert.ok(result.trace.some((entry) => entry.action === 'search' && entry.status === 'success'));
    assert.ok(result.trace.some((entry) => (
      entry.action === 'read'
      && ['improve_evidence', 'read_snippet', 'slot_repair_read', 'fallback_read_evidence'].includes(entry.reasonCode)
    )));
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
  });

  it('opens a new gap when the answer gate reports a missing aspect', async () => {
    const evaluations = [
      JSON.stringify({ pass: false, missingAspect: 'What are the deployment costs?' }),
      JSON.stringify({ pass: true, missingAspect: '' }),
    ];
    const decisions = [
      { action: 'search', query: 'gate topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://gate.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'first_try' },
      { action: 'search', query: 'gate topic deployment costs', gapId: 'gap-2', reasonCode: 'fill_gap' },
      { action: 'read', sourceIds: ['https://gate-costs.test'], gapId: 'gap-2', reasonCode: 'read_gap' },
      { action: 'answer', reasonCode: 'second_try' },
    ];
    const searches = [
      [{ title: 'Gate', url: 'https://gate.test', content: 'Gate topic evidence from a selected source.', fetchStatus: 'ok' }],
      [{ title: 'Costs', url: 'https://gate-costs.test', content: 'Deployment cost evidence from a selected source.', fetchStatus: 'ok' }],
    ];
    const result = await new ResearchRunner().run({
      query: 'gate topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 10, maxEvaluationRetries: 2, autoReadTopK: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return searches.shift() || []; } },
      llm: llmFor(decisions, {
        onEvaluation: () => evaluations.shift() || JSON.stringify({ pass: true, missingAspect: '' }),
        onProfile: keepExploringProfile,
      }),
    });
    const gateEntry = result.trace.find((entry) => entry.action === 'evaluate_report' && entry.reasonCode === 'answer_gate_failed');
    assert.equal(gateEntry.missingAspect, 'What are the deployment costs?');
    assert.ok(result.trace.some((entry) => entry.action === 'read' && entry.reasonCode === 'read_gap'));
    assert.ok(result.findings.some((finding) => finding.gapId === 'gap-2'));
  });

  it('decomposes the query into sub-gaps and searches with multiple queries in one step', async () => {
    const decisions = [
      { action: 'search', queries: ['ollama overview', 'ollama installation guide'], gapId: 'gap-2', reasonCode: 'multi_search' },
      { action: 'read', sourceIds: ['https://multi.test/a'], gapId: 'gap-2', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const searchedQueries = [];
    const result = await new ResearchRunner().run({
      query: 'compare ollama and llama.cpp',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, maxQueriesPerStep: 3 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(query) {
        searchedQueries.push(query);
        return [{ title: 'A', url: 'https://multi.test/a', snippet: 'snippet a', content: 'Multi topic evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions, {
        onDecompose: () => JSON.stringify({ subQuestions: ['How does ollama work?', 'How does llama.cpp work?'] }),
        onProfile: () => JSON.stringify({ requiredSourceTypes: ['numeric'] }),
      }),
    });

    const decompose = result.trace.find((entry) => entry.action === 'decompose');
    assert.equal(decompose.status, 'success');
    assert.equal(decompose.subQuestionCount, 2);
    assert.ok(decompose.targetGapIds.includes('gap-3'));
    assert.ok(searchedQueries.includes('ollama overview'));
    assert.ok(searchedQueries.includes('ollama installation guide'));
    const searchEntry = result.trace.find((entry) => entry.action === 'search' && entry.decisionStep);
    assert.equal(searchEntry.queryCount, 2);
    // Finding attaches to the agent-selected sub-gap, not the original question.
    assert.equal(result.findings[0].question, 'How does ollama work?');
  });

  it('records SERP snippets as knowledge after a search', async () => {
    const decisions = [
      { action: 'search', query: 'serp topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://serp.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    let observedKnowledge = null;
    const result = await new ResearchRunner().run({
      query: 'serp topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'Serp title', url: 'https://serp.test', snippet: 'useful snippet', content: 'Serp topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') {
          const snapshot = JSON.parse(messages.at(-1).content);
          if (snapshot.knowledge.some((entry) => entry.learned.startsWith('SERP:'))) observedKnowledge = snapshot.knowledge;
          return JSON.stringify(decisions.shift());
        }
        if (purpose === 'gap_decomposition') return 'no json';
        if (purpose === 'research_profile') return defaultContractProfile();
        if (purpose === 'gap_support') return defaultGapSupport(messages);
        return report();
      } },
    });
    assert.ok(result.report);
    assert.ok(observedKnowledge, 'agent should see SERP knowledge in its snapshot');
    assert.ok(observedKnowledge.some((entry) => entry.learned.includes('Serp title')));
  });

  it('auto-reads top ranked candidates after a search without an extra agent decision', async () => {
    let decisionCalls = 0;
    const decisions = [
      { action: 'search', query: 'auto topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'auto topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',         exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 2 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [
        { title: 'A', url: 'https://auto-a.test/page', content: 'Auto topic evidence from a selected source.', fetchStatus: 'ok' },
        { title: 'B', url: 'https://auto-b.test/page', content: 'More auto topic evidence from another host.', fetchStatus: 'ok' },
      ]; } },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') { decisionCalls += 1; return JSON.stringify(decisions.shift()); }
        if (purpose === 'gap_decomposition') return 'no json';
        if (purpose === 'research_profile') return defaultContractProfile();
        if (purpose === 'gap_support') return defaultGapSupport(messages);
        return report();
      } },
    });
    const autoRead = result.trace.find((entry) => entry.action === 'read' && entry.reasonCode === 'auto_read_top_ranked');
    assert.ok(autoRead, 'search should be followed by an automatic read');
    assert.equal(autoRead.sourceIds.length, 2);
    assert.equal(decisionCalls, 1);
    assert.equal(result.quality.stopReason, 'evidence_sufficient');
  });

  it('uses extract mode without source_summary LLM calls when embedding is configured', async () => {
    const { registerContentFetchHandler, resetContentFetchHandlers } = await import('../src/research/content-resolver.mjs');
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: 'Extract article',
      content: 'Ollama wraps llama.cpp for easy local deployment. llama.cpp is a low-level C++ engine for efficient inference.',
      backend: 'test',
    }));

    const decisions = [
      { action: 'search', query: 'extract topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://extract.test/page'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const purposes = [];
    const result = await new ResearchRunner().run({
      query: 'extract topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 0 },
        focused: { fetchMode: 'extract', fetchBackend: 'auto' },
        providers: {
          embedding: {
            async embedDocuments(texts) {
              return texts.map((text) => (String(text).toLowerCase().includes('llama.cpp') ? [1, 0] : [0, 1]));
            },
          },
        },
      } },
      search: { async search() { return [{ title: 'Extract', url: 'https://extract.test/page', snippet: 'snippet', content: 'Extract topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: { async complete({ purpose, messages }) {
        purposes.push(purpose);
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
        if (purpose === 'gap_decomposition') return 'no json';
        if (purpose === 'research_profile') return defaultContractProfile();
        if (purpose === 'gap_support') return defaultGapSupport(messages);
        if (purpose === 'source_summary') throw new Error('extract mode should not call source_summary');
        if (purpose === 'source_assessment') throw new Error('extract mode should not call source_assessment unless enabled');
        return report();
      } },
    });

    resetContentFetchHandlers();
    assert.ok(result.findings.length > 0);
    assert.equal(purposes.includes('source_summary'), false);
    assert.equal(purposes.includes('source_assessment'), false);
    assert.ok(result.findings.some((finding) => (finding.sources || []).some((source) => source.extractionMethod === 'embedding')));
  });

  it('auto-read respects the sourceReads budget without throwing', async () => {
    const decisions = [
      { action: 'search', query: 'budget read topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget read topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, maxSourceReads: 1, autoReadTopK: 2 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [
        { title: 'A', url: 'https://budget-a.test/page', content: 'Budget read evidence.', fetchStatus: 'ok' },
        { title: 'B', url: 'https://budget-b.test/page', content: 'Second host evidence.', fetchStatus: 'ok' },
      ]; } },
      llm: llmFor(decisions),
    });
    const autoRead = result.trace.find((entry) => entry.reasonCode === 'auto_read_top_ranked');
    assert.ok(autoRead);
    assert.equal(autoRead.sourceIds.length, 1);
    assert.ok(result.report);
  });

  it('executes multiple search queries in parallel within the search budget', async () => {
    let active = 0;
    let maxActive = 0;
    const searchedQueries = [];
    const decisions = [
      { action: 'search', queries: ['parallel topic one', 'parallel topic two', 'parallel topic three'], gapId: 'gap-1', reasonCode: 'multi' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'parallel topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, maxQueriesPerStep: 3, autoReadTopK: 0, maxSearchRequests: 2 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search(query) {
        searchedQueries.push(query);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return [{ title: 'P', url: `https://parallel.test/${searchedQueries.length}`, content: 'Parallel topic evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions),
    });
    assert.deepEqual(searchedQueries, ['parallel topic one', 'parallel topic two']);
    assert.ok(maxActive >= 2, `queries should overlap, saw maxActive=${maxActive}`);
    assert.equal(result.quality.budget.usage.searchRequests, 2);
  });

  it('forces a final answer on the last step instead of exploring past max steps', async () => {
    const decisions = [
      { action: 'search', query: 'forced topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://forced.test'], gapId: 'gap-1', reasonCode: 'keep_reading' },
    ];
    const result = await new ResearchRunner().run({
      query: 'forced topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 2, maxEvaluationRetries: 1 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'F', url: 'https://forced.test', content: 'Forced topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'forced' && entry.reasonCode === 'forced_final_answer'));
    assert.ok(result.trace.some((entry) => entry.action === 'answer' && entry.reasonCode === 'forced_final_answer'));
  });

  it('uses the no-yield safety cap instead of the retired 16-step default', async () => {
    const decisions = Array.from({ length: 18 }, (_, index) => ({
      action: 'search',
      query: `open topic space angle ${index}`,
      gapId: 'gap-1',
      reasonCode: `s${index}`,
    }));
    decisions.push({ action: 'answer', reasonCode: 'done' });
    const result = await new ResearchRunner().run({
      query: 'open topic space',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 0,
          maxLlmTokens: 80000,
          maxSteps: 0,
          maxEvaluationRetries: 0,
          autoReadTopK: 0,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [];
      } },
      llm: llmFor(decisions, { onDecompose: () => 'no json' }),
    });
    assert.ok(!result.trace.some((entry) => entry.reasonCode === 'forced_final_answer'));
    assert.notEqual(result.quality.stopReason, 'max_steps_safety');
    assert.equal(result.quality.stopReason, 'safety_cap');
    assert.ok(['repair_exhausted', 'query_planner_exhausted'].includes(result.quality.stopDetail));
    assert.ok(result.quality.budget.usage.searchRequests <= 18);
  });

  it('keeps gathered candidates and marks findings degraded when the budget is exhausted', async () => {
    let decisionCalls = 0;
    const decisions = [
      { action: 'search', query: 'first', gapId: 'gap-1' },
      { action: 'read', sourceIds: ['https://first.test'], gapId: 'gap-1', reasonCode: 'should_not_decide_after_cap' },
      { action: 'search', query: 'second unrelated query', gapId: 'gap-1' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, maxSearchRequests: 1 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'First', url: 'https://first.test', snippet: 'gathered evidence' }]; } },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') {
            decisionCalls += 1;
            return JSON.stringify(decisions.shift());
          }
          if (purpose === 'answer_evaluation') return report();
          if (purpose === 'gap_decomposition') return 'no json here';
          if (purpose === 'research_profile') return defaultContractProfile();
          if (purpose === 'gap_support') return defaultGapSupport(messages);
          return report();
        },
      },
    });
    assert.equal(result.findings[0].sources[0].url, 'https://first.test');
    assert.equal(result.findings[0].degraded, true);
    assert.ok(result.trace.some((entry) => ['budget_exhausted', 'max_budget_exhausted'].includes(entry.reasonCode)));
    assert.equal(decisionCalls, 1);
    assert.ok(!result.trace.some((entry) => entry.reasonCode === 'should_not_decide_after_cap'));
  });

  it('keeps a comparison query open until each subject has body evidence', async () => {
    const searches = [
      [{ title: 'Ollama', url: 'https://ollama.com', content: 'Ollama is a local model runner.', fetchStatus: 'ok' }],
      [{ title: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp', content: 'llama.cpp is a C++ inference engine.', fetchStatus: 'ok' }],
    ];
    const decisions = [
      { action: 'search', query: 'ollama overview', gapId: 'gap-1', reasonCode: 'search_ollama' },
      { action: 'search', query: 'llama.cpp overview', gapId: 'gap-1', reasonCode: 'search_llamacpp' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'Compare Ollama and llama.cpp',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 2, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() { return searches.shift() || []; } },
      llm: llmFor(decisions, {
        onDecompose: () => JSON.stringify({ subQuestions: ['How does Ollama work?', 'How does llama.cpp work?'] }),
        onProfile: () => JSON.stringify({
          requiredAnswerSlots: [
            { answerSlot: 'Ollama', question: 'How does Ollama work?', priority: 'critical' },
            { answerSlot: 'llama.cpp', question: 'How does llama.cpp work?', priority: 'critical' },
          ],
          minIndependentSources: 1,
        }),
        onGapSupport: () => JSON.stringify({
          judgments: [
            { gapId: 'gap-2', verdict: 'supported', quote: 'Ollama is a local model runner.' },
            { gapId: 'gap-3', verdict: 'supported', quote: 'llama.cpp is a C++ inference engine.' },
          ],
        }),
      }),
    });
    assert.equal(result.quality.budget.usage.searchRequests, 2);
    assert.equal(result.quality.stopReason, 'evidence_sufficient');
    const texts = result.findings.flatMap((finding) => (finding.sources || []).map((source) => `${source.title} ${source.content}`)).join(' ');
    assert.match(texts, /Ollama/);
    assert.match(texts, /llama\.cpp/);
  });

  it('does not let a model sufficient_evidence reason pass a failed readiness gate', async () => {
    const decisions = [
      { action: 'search', query: 'ollama overview', gapId: 'gap-1', reasonCode: 'search_ollama' },
      { action: 'answer', reasonCode: 'sufficient_evidence' },
    ];
    const result = await new ResearchRunner().run({
      query: 'Compare Ollama and llama.cpp',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 6, maxEvaluationRetries: 0, autoReadTopK: 1, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [{ title: 'Ollama', url: 'https://ollama.com', content: 'Ollama is a local model runner.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions, {
        onDecompose: () => JSON.stringify({ subQuestions: ['How does Ollama work?', 'How does llama.cpp work?'] }),
        onProfile: () => JSON.stringify({
          requiredAnswerSlots: [
            { answerSlot: 'Ollama', question: 'How does Ollama work?', priority: 'critical' },
            { answerSlot: 'llama.cpp', question: 'How does llama.cpp work?', priority: 'critical' },
          ],
          minIndependentSources: 1,
        }),
        onGapSupport: () => JSON.stringify({
          judgments: [
            { gapId: 'gap-2', verdict: 'supported', quote: 'Ollama is a local model runner.' },
            { gapId: 'gap-3', verdict: 'unsupported', quote: 'Ollama is a local model runner.' },
          ],
        }),
      }),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(['safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.notEqual(result.quality.stopReason, 'source_blocked');
    assert.notEqual(result.quality.budget.controllerStopReason, 'evidence_sufficient');
  });

  it('stops a definitional query on evidence_sufficient without opening paraphrased gaps', async () => {
    const events = [];
    const result = await new ResearchRunner().run({
      query: 'What is Ollama?',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      onProgress: (event) => events.push(event.message),
      search: { async search() {
        return [{
          title: 'Ollama docs',
          url: 'https://ollama.com',
          snippet: 'Ollama runs local models',
          content: 'Ollama is a tool for running large language models locally.',
          fetchStatus: 'ok',
        }];
      } },
      llm: llmFor(
        [{ action: 'search', query: 'What is Ollama?', gapId: 'gap-1', reasonCode: 'find_sources' }],
        { onDecompose: () => JSON.stringify({ subQuestions: ['What features does Ollama have?', 'How do you install Ollama?'] }) },
      ),
    });
    assert.equal(result.quality.stopReason, 'evidence_sufficient');
    assert.equal(result.quality.budget.controllerStopReason, 'evidence_sufficient');
    assert.ok((result.quality.budget.usage.llmTokens || 0) < 20000);
    assert.ok(['decompose_skipped_definitional', 'decompose_skipped_slots'].includes(
      result.trace.find((entry) => entry.action === 'decompose')?.reasonCode,
    ));
    assert.ok(!result.trace.some((entry) => entry.action === 'reflect'));
    assert.ok(events.every((message) => !/undefined\/undefined/.test(message)));
    assert.ok(events.some((message) => /Research stopped: evidence_sufficient/.test(message)));
    assert.ok(!events.some((message) => /Research stopped: max_steps/.test(message)));
  });

  it('keeps exploring below the token floor even when evidence already looks sufficient', async () => {
    const decisions = [
      { action: 'search', query: 'What is Ollama?', gapId: 'gap-1', reasonCode: 'find_sources' },
      { action: 'answer', reasonCode: 'should_not_stop_below_min' },
      { action: 'answer', reasonCode: 'should_not_stop_below_min' },
    ];
    const result = await new ResearchRunner().run({
      query: 'What is Ollama?',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: {
          minLlmTokens: 50000,
          maxLlmTokens: 80000,
          maxSteps: 5,
          maxEvaluationRetries: 0,
          autoReadTopK: 1,
        },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [
          { title: 'Ollama', url: 'https://ollama.com', content: 'Ollama is a tool for running large language models locally.', fetchStatus: 'ok' },
          { title: 'GitHub', url: 'https://github.com/ollama/ollama', content: 'Ollama repository and install docs.', fetchStatus: 'ok' },
        ];
      } },
      llm: llmFor(decisions),
    });
    assert.notEqual(result.quality.stopReason, 'evidence_sufficient');
    assert.ok(result.trace.some((entry) => (
      entry.reasonCode === 'fallback_read_evidence' || entry.reasonCode === 'fallback_explore_below_min'
    )));
    assert.ok(!result.trace.some((entry) => (
      entry.action === 'answer' && entry.reasonCode === 'should_not_stop_below_min'
    )));
  });

  it('auto-read does not consume a decision step or block a later read of other sources', async () => {
    const decisions = [
      { action: 'search', query: 'harvest extra sources', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://harvest-b.test/page'], gapId: 'gap-1', reasonCode: 'extra_read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'harvest extra sources',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 8, maxEvaluationRetries: 0, autoReadTopK: 1, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [
          { title: 'A', url: 'https://harvest-a.test/page', content: 'First host body evidence.', fetchStatus: 'ok' },
          { title: 'B', url: 'https://harvest-b.test/page', content: 'Second host body evidence.', fetchStatus: 'ok' },
          { title: 'C', url: 'https://harvest-c.test/page', content: 'Third host body evidence.', fetchStatus: 'ok' },
        ];
      } },
      llm: llmFor(decisions, { onProfile: keepExploringProfile }),
    });
    const autoRead = result.trace.find((entry) => entry.action === 'read' && entry.reasonCode === 'auto_read_top_ranked');
    const extraRead = result.trace.find((entry) => entry.action === 'read' && entry.reasonCode === 'extra_read');
    assert.ok(autoRead, 'auto-read should harvest after search');
    assert.equal(autoRead.harvest, true);
    assert.equal(autoRead.decisionStep, false);
    assert.ok(extraRead, 'a later read of a different unread source must be allowed');
    assert.equal(extraRead.loopStep, autoRead.loopStep + 1);
    assert.ok(!result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'repeat_action'));
  });

  it('does not record an agent answer as max_steps and uses step language for enrich', async () => {
    const events = [];
    const decisions = [
      { action: 'search', query: 'stop reason topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'stop reason topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 2, maxEvaluationRetries: 0, autoReadTopK: 1, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      onProgress: (event) => events.push(event.message),
      search: { async search() {
        return [{ title: 'S', url: 'https://stop-reason.test', content: 'Stop reason topic evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions),
    });
    assert.notEqual(result.quality.stopReason, 'max_steps');
    assert.ok(['evidence_sufficient', 'safety_cap', 'budget_exhausted'].includes(result.quality.stopReason));
    assert.notEqual(result.quality.stopReason, 'source_blocked');
    assert.ok(events.some((message) => /Enriching sources for step \d+\/\d+/.test(message)));
    assert.ok(events.every((message) => !/undefined\/undefined/.test(message)));
    assert.ok(!events.some((message) => /Research stopped: max_steps/.test(message)));
  });

  it('reserves report tokens and stops with max_budget_exhausted instead of max_steps', async () => {
    const events = [];
    const decisions = [
      { action: 'search', query: 'budget exhaustion topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'search', query: 'budget exhaustion follow up', gapId: 'gap-1', reasonCode: 'search_more' },
      { action: 'read', sourceIds: ['https://budget-cap.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget exhaustion topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 12, maxEvaluationRetries: 0, targetLlmTokens: 0, autoReadTopK: 2 },
        focused: { fetchMode: 'disabled' },
        budget: { maxLlmTokens: 2500, reserveReportTokens: 800, maxSearchRequests: 8, maxSourceReads: 8 },
      } },
      onProgress: (event) => events.push(event.message),
      search: { async search() {
        return [{ title: 'Cap', url: 'https://budget-cap.test', content: 'Budget exhaustion topic evidence from a selected source.', fetchStatus: 'ok' }];
      } },
      llm: llmFor(decisions, { onDecompose: () => 'no json', onProfile: keepExploringProfile }),
    });
    assert.equal(result.quality.stopReason, 'budget_exhausted');
    assert.notEqual(result.quality.stopReason, 'max_steps');
    assert.equal(result.quality.budget.reservedReportTotalTokens, 0);
    assert.ok(result.report);
    assert.match(result.report, /## Evidence/);
    assert.match(result.report, /## Sources/);
    assert.ok(events.every((message) => !/undefined\/undefined/.test(message)));
    assert.ok(!events.some((message) => /Research stopped: max_steps/.test(message)));
  });

  it('ignores a persisted global sourceReads cap when exploratory counts are unlimited', async () => {
    const { registerContentFetchHandler, resetContentFetchHandlers } = await import('../src/research/content-resolver.mjs');
    registerContentFetchHandler(async (_url, context) => ({
      status: 'ok',
      title: context.source?.title || 'Source',
      content: context.source?.content || 'Official body evidence with enough characters to count as a successful fetched page.',
      backend: 'test',
    }));
    let searchIndex = 0;
    const decisions = [
      { action: 'search', query: 'alpha docs', gapId: 'gap-1', reasonCode: 's1' },
      { action: 'search', query: 'beta docs', gapId: 'gap-1', reasonCode: 's2' },
      { action: 'search', query: 'gamma docs', gapId: 'gap-1', reasonCode: 's3' },
      { action: 'search', query: 'delta docs', gapId: 'gap-1', reasonCode: 's4' },
      { action: 'answer', reasonCode: 'done' },
    ];
    try {
      const result = await new ResearchRunner().run({
        query: 'Compare alpha, beta, gamma, and delta',
        settings: { llm: {}, search: {}, research: {
          strategy: 'exploratory',
          exploratory: {
            minLlmTokens: 0,
            maxLlmTokens: 0,
            maxSteps: 10,
            maxEvaluationRetries: 0,
            autoReadTopK: 3,
            maxReadsPerStep: 4,
            maxSearchRequests: 0,
            maxSourceReads: 0,
          },
          focused: { fetchMode: 'full', fetchBackend: 'auto' },
          budget: { maxSourceReads: 8, maxSearchRequests: 8 },
        } },
        search: { async search() {
          searchIndex += 1;
          const subject = ['alpha', 'beta', 'gamma', 'delta'][searchIndex - 1] || 'other';
          return [1, 2, 3].map((n) => ({
            title: `${subject} ${n}`,
            url: `https://${subject}-${n}.example/page`,
            content: `${subject} official documentation item ${n} with enough fetched body text for evidence.`,
            fetchStatus: 'ok',
          }));
        } },
        llm: llmFor(decisions, { onDecompose: () => 'no json' }),
      });
      assert.ok(result.quality.budget.usage.sourceReads > 8);
      assert.equal(result.quality.budget.limits.sourceReads, 0);
    } finally {
      resetContentFetchHandlers();
    }
  });

  it('answers immediately when an explicit exploratory sourceReads cap is exhausted', async () => {
    const { registerContentFetchHandler, resetContentFetchHandlers } = await import('../src/research/content-resolver.mjs');
    registerContentFetchHandler(async (_url, context) => ({
      status: 'ok',
      title: context.source?.title || 'Source',
      content: context.source?.content || 'Official body evidence with enough characters to count as a successful fetched page.',
      backend: 'test',
    }));
    let decisionCalls = 0;
    const decisions = [
      { action: 'search', query: 'cap topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://cap-b.test'], gapId: 'gap-1', reasonCode: 'should_not_run' },
      { action: 'search', query: 'more after cap', gapId: 'gap-1', reasonCode: 'should_not_run' },
    ];
    try {
      const result = await new ResearchRunner().run({
        query: 'cap topic',
        settings: { llm: {}, search: {}, research: {
          strategy: 'exploratory',
          exploratory: {
            minLlmTokens: 0,
            maxLlmTokens: 0,
            maxSteps: 8,
            maxEvaluationRetries: 0,
            autoReadTopK: 1,
            maxSourceReads: 1,
          },
          focused: { fetchMode: 'full', fetchBackend: 'auto' },
        } },
        search: { async search() {
          return [
            { title: 'A', url: 'https://cap-a.test', content: 'Cap topic evidence from host A.', fetchStatus: 'ok' },
            { title: 'B', url: 'https://cap-b.test', content: 'Cap topic evidence from host B.', fetchStatus: 'ok' },
          ];
        } },
        llm: {
          async complete({ purpose, messages }) {
            if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'agent_decision') {
              decisionCalls += 1;
              return JSON.stringify(decisions.shift());
            }
            if (purpose === 'answer_evaluation') return report();
            if (purpose === 'gap_decomposition') return 'no json here';
            if (purpose === 'research_profile') return defaultContractProfile();
            if (purpose === 'gap_support') return defaultGapSupport(messages);
            return report();
          },
        },
      });
      assert.equal(decisionCalls, 1);
      assert.equal(result.quality.stopReason, 'budget_exhausted');
      assert.ok(result.trace.some((entry) => ['budget_exhausted', 'max_budget_exhausted'].includes(entry.reasonCode)));
      assert.ok(!result.trace.some((entry) => entry.reasonCode === 'should_not_run'));
    } finally {
      resetContentFetchHandlers();
    }
  });

  it('rejects a consecutive read of the same sources and falls back without reflect', async () => {
    const decisions = [
      { action: 'search', query: 'open topic space', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://open-a.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'read', sourceIds: ['https://open-a.test'], gapId: 'gap-1', reasonCode: 'read_again' },
      { action: 'reflect', gapQuestion: 'What is a paraphrased open topic space?', reasonCode: 'should_not_run' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'open topic space',
      settings: { llm: {}, search: {}, research: {
        strategy: 'exploratory',
        exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 10, maxEvaluationRetries: 0, autoReadTopK: 0, targetLlmTokens: 0 },
        focused: { fetchMode: 'disabled' },
      } },
      search: { async search() {
        return [
          { title: 'A', url: 'https://open-a.test', content: 'Open topic space evidence from host A.', fetchStatus: 'ok' },
          { title: 'B', url: 'https://open-b.test', content: 'Open topic space evidence from host B.', fetchStatus: 'ok' },
        ];
      } },
      llm: llmFor(decisions, { onProfile: keepExploringProfile }),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'repeat_action'));
    assert.ok(result.trace.some((entry) => (
      entry.action === 'read' && ['fallback_read_evidence', 'slot_repair_read'].includes(entry.reasonCode)
    )));
    assert.ok(!result.trace.some((entry) => entry.action === 'reflect' && entry.reasonCode === 'fallback_reflect_gaps'));
    assert.ok(!result.trace.some((entry) => entry.action === 'reflect' && entry.reasonCode === 'should_not_run'));
  });
});
