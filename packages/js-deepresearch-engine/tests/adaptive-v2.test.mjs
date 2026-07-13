import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';

function report() {
  return '# Research Report\n\n## Key Findings\n\nThe selected source provides evidence for the requested topic and preserves agent source choice. [1.1]\n\n## Evidence\n\nThe source was selected deliberately by the research agent and remains traceable in the findings. [1.1]';
}

describe('adaptive v2 agent loop', () => {
  it('enforces action preconditions without encoding research policy', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 3 });
    assert.equal(state.validate({ action: 'read', sourceIds: ['missing'] }), 'unknown_source');
    assert.equal(state.validate({ action: 'search' }), 'missing_query');
    assert.equal(state.validate({ action: 'answer' }), 'no_evidence');
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
      llm: { async complete({ purpose }) {
        if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
        return report();
      } },
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
      llm: { async complete({ purpose }) {
        if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
        return report();
      } },
    });
    assert.ok(result.trace.some((entry) => entry.status === 'rejected' && entry.reasonCode === 'unknown_source'));
    assert.ok(result.trace.some((entry) => entry.action === 'search'));
  });

  it('allows one evidence-driven improvement cycle before answering', async () => {
    const decisions = [
      { action: 'search', query: 'quality topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'answer', reasonCode: 'premature' },
      { action: 'read', sourceIds: ['https://quality.test'], gapId: 'gap-1', reasonCode: 'improve_evidence' },
      { action: 'answer', reasonCode: 'supported' },
    ];
    const result = await new ResearchRunner().run({
      query: 'quality topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 6, maxEvaluationRetries: 1 },
        sourceBased: { fetchMode: 'disabled' },
      } },
      search: { async search() { return [{ title: 'Quality', url: 'https://quality.test', content: 'The selected source provides evidence for the requested topic and preserves agent source choice.', fetchStatus: 'ok' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
        return report();
      } },
    });
    const retry = result.trace.find((entry) => entry.action === 'evaluate_report' && entry.status === 'retry');
    assert.equal(retry.allowedAdditionalActions, 1);
    assert.ok(result.trace.some((entry) => entry.action === 'read' && entry.reasonCode === 'improve_evidence'));
  });

  it('keeps gathered candidates when a later action exhausts the budget', async () => {
    const decisions = [
      { action: 'search', query: 'first', gapId: 'gap-1' },
      { action: 'search', query: 'second', gapId: 'gap-1' },
    ];
    const result = await new ResearchRunner().run({
      query: 'budget topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'adaptive', adaptive: { loopVersion: 'v2', maxSteps: 4 },
        sourceBased: { fetchMode: 'disabled' }, budget: { maxSearchRequests: 1 },
      } },
      search: { async search() { return [{ title: 'First', url: 'https://first.test', snippet: 'gathered evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
        return report();
      } },
    });
    assert.equal(result.findings[0].sources[0].url, 'https://first.test');
    assert.ok(result.trace.some((entry) => entry.reasonCode === 'budget_exhausted'));
  });
});
