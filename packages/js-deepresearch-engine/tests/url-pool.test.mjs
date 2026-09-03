import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UrlPool } from '../src/research/adaptive/url-pool.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';

describe('per-gap URL discovery metadata', () => {
  it('retains every discovering gap and its queries for the same URL', () => {
    const pool = new UrlPool();
    pool.add({ id: 'shared', url: 'https://example.com/shared', title: 'Shared' }, {
      gapId: 'gap-2',
      query: 'financial query',
      gap: { question: 'financials' },
    });
    pool.add({ id: 'shared', url: 'https://example.com/shared', title: 'Shared' }, {
      gapId: 'gap-3',
      query: 'technology query',
      gap: { question: 'technology' },
    });
    const record = pool.get('shared');
    assert.deepEqual(record.gapIds, ['gap-2', 'gap-3']);
    assert.deepEqual(record.gapMatches['gap-2'].queries, ['financial query']);
    assert.deepEqual(record.gapMatches['gap-3'].queries, ['technology query']);
  });

  it('selects the target gap score instead of the first sticky score', () => {
    const state = new ResearchState({ query: 'company research' });
    state.addGap('financial performance', 'critical', { id: 'gap-2' });
    state.addGap('technology moat', 'critical', { id: 'gap-3' });
    state.addCandidates([{
      id: 'shared',
      url: 'https://example.com/shared',
      title: 'Shared company source',
      rerank: { provider: 'http', score: 0.8 },
    }], 'gap-2', { query: 'financial query' });
    state.addCandidates([{
      id: 'shared',
      url: 'https://example.com/shared',
      title: 'Shared company source',
      rerank: { provider: 'http', score: 0.2 },
    }], 'gap-3', { query: 'technology query' });
    const candidate = state.candidates.get('shared');
    candidate.gapMatches['gap-2'].rerank = { provider: 'http', score: 0.8 };
    candidate.gapMatches['gap-3'].rerank = { provider: 'http', score: 0.2 };
    assert.equal(state.pickPolicyReads(1, 'gap-2')[0].rerankScore, 0.8);
    assert.equal(state.pickPolicyReads(1, 'gap-3')[0].rerankScore, 0.2);
  });

  it('does not leak another gap score when the current gap has no evaluation', () => {
    const state = new ResearchState({ query: 'company research' });
    state.addGap('financial performance', 'critical', { id: 'gap-2' });
    state.addGap('technology moat', 'critical', { id: 'gap-3' });
    state.addCandidates([{
      id: 'shared',
      url: 'https://example.com/shared',
      title: 'Shared company source',
      rerank: { provider: 'http', score: 0.8 },
    }], 'gap-2', { query: 'financial query' });
    state.addCandidates([{
      id: 'shared',
      url: 'https://example.com/shared',
      title: 'Shared company source',
    }], 'gap-3', { query: 'technology query' });
    const candidate = state.candidates.get('shared');
    candidate.gapMatches['gap-2'].rerank = { provider: 'http', score: 0.8 };
    const picked = state.pickPolicyReads(1, 'gap-3');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].rerankScore, null);
  });
});
