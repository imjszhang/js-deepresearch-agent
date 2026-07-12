import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetExceededError, BudgetManager, QueryMemory, buildEvidenceArtifacts, normalizeSourceUrl, selectDiverseSources } from '../src/index.mjs';

describe('research control infrastructure', () => {
  it('enforces search and source-read budgets', () => {
    const manager = new BudgetManager({ research: { budget: { maxSearchRequests: 1, maxSourceReads: 1 } } });
    manager.claim('searchRequests');
    assert.throws(() => manager.claim('searchRequests'), BudgetExceededError);
    manager.claim('sourceReads');
    assert.equal(manager.snapshot().usage.sourceReads, 1);
  });

  it('deduplicates normalized and overlapping queries', async () => {
    const memory = new QueryMemory({ enabled: true, similarityThreshold: 0.7 });
    memory.record({ query: 'Current LLM Wiki research', gapId: 'g1', status: 'useful', results: [] });
    assert.ok(await memory.findDuplicate('current llm wiki research', 'g1'));
    assert.equal(await memory.findDuplicate('different topic', 'g1'), null);
  });

  it('normalizes tracking URLs and enforces hostname diversity', () => {
    assert.equal(normalizeSourceUrl('https://example.com/a/?utm_source=x#part'), 'https://example.com/a');
    const selected = selectDiverseSources([
      { title: 'A', url: 'https://example.com/a' },
      { title: 'B', url: 'https://example.com/b' },
      { title: 'C', url: 'https://other.test/c' },
    ], { enabled: true, maxPerHostname: 1 });
    assert.deepEqual(selected.map((item) => item.title), ['A', 'C']);
  });

  it('builds stable passage and claim evidence chains', () => {
    const result = buildEvidenceArtifacts({
      query: 'What is local-first AI?',
      findings: [{ question: 'What is local-first AI?', sources: [{ title: 'Primary', url: 'https://example.com/a', content: 'Local-first AI keeps user data on devices and synchronizes selectively. This architecture improves privacy and offline access.' }] }],
      report: '# Key Findings\n\nLocal-first AI keeps user data on devices and improves privacy and offline access through selective synchronization.',
      options: { maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true },
    });
    assert.equal(result.passages.length, 1);
    assert.equal(result.claims.length, 1);
    assert.ok(result.claims[0].evidence[0].passageId);
    assert.equal(result.findings[0].evidenceStatus, 'direct_evidence');
  });
});
