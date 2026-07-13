import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';

function report() {
  return '# Research Report\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]\n\n## Evidence\n\nThe source was selected deliberately by the research agent and remains traceable in the findings. [1.1]';
}

function llmFor(decisions, { onEvaluation = () => report() } = {}) {
  return {
    async complete({ purpose }) {
      if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
      if (purpose === 'answer_evaluation') return onEvaluation();
      return report();
    },
  };
}

describe('adaptive v2 agent loop', () => {
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
    assert.equal(state.validate({ action: 'search', query: 'another query' }), 'repeat_action');
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
    assert.equal(snapshot.candidates.filter((candidate) => candidate.url.startsWith('https://dup.test')).length, 2);
    assert.equal(snapshot.candidates[0].url, 'https://dup.test/one');
    assert.deepEqual(snapshot.searchedQueries, ['topic query']);
    assert.equal(snapshot.knowledge.length, 1);
    assert.equal(snapshot.knowledge[0].learned.length, 160);
    assert.equal(snapshot.stepsRemaining, 10);
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
    assert.deepEqual(action.sourceIds, ['https://high.test/page']);
  });

  it('falls back to reflect instead of answering when every candidate is read after a search', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 10 });
    state.addCandidates([{ url: 'https://done.test/page', title: 'Done' }], 'gap-1');
    state.readSourceIds.add('https://done.test/page');
    state.lastAction = 'search';
    assert.equal(fallbackAdaptiveAction(state).action, 'reflect');

    state.lastAction = 'reflect';
    assert.equal(fallbackAdaptiveAction(state).action, 'answer');
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
          strategy: 'adaptive',
          adaptive: { loopVersion: 'v2', maxSteps: 5, maxEvaluationRetries: 0 },
          providers: { embedding: { provider: 'disabled' }, rerank: { provider: 'rules' } },
          sourceBased: { fetchMode: 'disabled', evidencePassages: { enabled: true, claimAlignment: true } },
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
        strategy: 'adaptive',
        adaptive: { loopVersion: 'v2', maxSteps: 5, maxEvaluationRetries: 0 },
        sourceBased: { fetchMode: 'disabled' },
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
      { action: 'search', query: 'gated topic variation', gapId: 'gap-1', reasonCode: 'search_again' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'gated topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 6, maxEvaluationRetries: 0 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'G', url: 'https://gated.test', content: 'Gated topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'repeat_action'));
    assert.ok(result.trace.some((entry) => entry.action === 'read' && entry.reasonCode === 'fallback_read_evidence'));
    assert.equal(result.quality.budget.usage.searchRequests, 1);
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
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 8, maxEvaluationRetries: 0 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'D', url: 'https://dupquery.test', content: 'Duplicate query topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'duplicate_query'));
    assert.equal(result.quality.budget.usage.searchRequests, 1);
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
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 8, maxEvaluationRetries: 1 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return searches.shift() || []; } },
      llm: llmFor(decisions),
    });
    const retry = result.trace.find((entry) => entry.action === 'evaluate_report' && entry.status === 'retry');
    assert.equal(retry.reasonCode, 'missing_direct_evidence');
    assert.equal(retry.allowedAdditionalActions, 1);
    assert.ok(result.trace.some((entry) => entry.action === 'read' && entry.reasonCode === 'improve_evidence'));
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
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 10, maxEvaluationRetries: 2 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return searches.shift() || []; } },
      llm: llmFor(decisions, { onEvaluation: () => evaluations.shift() || JSON.stringify({ pass: true, missingAspect: '' }) }),
    });
    const gateEntry = result.trace.find((entry) => entry.action === 'evaluate_report' && entry.reasonCode === 'answer_gate_failed');
    assert.equal(gateEntry.missingAspect, 'What are the deployment costs?');
    assert.ok(result.trace.some((entry) => entry.action === 'read' && entry.reasonCode === 'read_gap'));
    assert.ok(result.findings.some((finding) => finding.gapId === 'gap-2'));
  });

  it('forces a final answer on the last step instead of exploring past max steps', async () => {
    const decisions = [
      { action: 'search', query: 'forced topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://forced.test'], gapId: 'gap-1', reasonCode: 'keep_reading' },
    ];
    const result = await new ResearchRunner().run({
      query: 'forced topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 2, maxEvaluationRetries: 1 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'F', url: 'https://forced.test', content: 'Forced topic evidence from a selected source.', fetchStatus: 'ok' }]; } },
      llm: llmFor(decisions),
    });
    assert.ok(result.trace.some((entry) => entry.status === 'forced' && entry.reasonCode === 'forced_final_answer'));
    assert.ok(result.trace.some((entry) => entry.action === 'answer' && entry.reasonCode === 'forced_final_answer'));
  });

  it('keeps gathered candidates and marks findings degraded when the budget is exhausted', async () => {
    const decisions = [
      { action: 'search', query: 'first', gapId: 'gap-1' },
      { action: 'read', sourceIds: ['https://first.test'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'search', query: 'second unrelated query', gapId: 'gap-1' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 6, maxEvaluationRetries: 0 },
        sourceBased: { fetchMode: 'disabled' }, budget: { maxSearchRequests: 1 },
      } },
      search: { async search() { return [{ title: 'First', url: 'https://first.test', snippet: 'gathered evidence' }]; } },
      llm: llmFor(decisions),
    });
    assert.equal(result.findings[0].sources[0].url, 'https://first.test');
    assert.equal(result.findings[0].degraded, true);
    assert.ok(result.trace.some((entry) => entry.reasonCode === 'budget_exhausted'));
  });
});
