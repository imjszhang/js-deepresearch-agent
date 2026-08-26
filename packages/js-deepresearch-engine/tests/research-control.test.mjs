import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetExceededError, BudgetManager, QueryMemory, SourceCandidatePool, buildEvidenceArtifacts, normalizeSourceUrl, selectDiverseSources } from '../src/index.mjs';

describe('research control infrastructure', () => {
  it('enforces search and source-read budgets', () => {
    const events = [];
    const manager = new BudgetManager({ research: { budget: { maxSearchRequests: 1, maxSourceReads: 1 } } }, (event) => events.push(event));
    manager.claim('searchRequests');
    assert.throws(() => manager.claim('searchRequests'), BudgetExceededError);
    assert.throws(() => manager.claim('searchRequests'), BudgetExceededError);
    manager.claim('sourceReads');
    assert.equal(manager.snapshot().usage.sourceReads, 1);
    assert.equal(events.filter((event) => event.stage === 'budget_exhausted' && event.kind === 'searchRequests').length, 1);
  });

  it('reserves report prompt and output tokens against the hard LLM cap', () => {
    const manager = new BudgetManager({ research: { budget: { maxLlmTokens: 4000, reserveReportTokens: 1000 } } });
    manager.updateReportReserve(500);
    assert.equal(manager.canClaim('llmTokens', 2600), false);
    assert.equal(manager.canClaim('llmTokens', 2000), true);
    manager.claim('llmTokens', 2000);
    assert.equal(manager.canClaim('llmTokens', 800, { report: true }), true);
    assert.ok(manager.snapshot().reservedReportTotalTokens >= 1000);
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
      findings: [{ question: 'What is local-first AI?', sources: [{ title: 'Primary', url: 'https://example.com/a', content: 'Local-first AI keeps user data on devices and synchronizes selectively. This architecture improves privacy and offline access.', fetchStatus: 'ok', contentOrigin: 'fetched' }] }],
      report: '# Key Findings\n\nLocal-first AI keeps user data on devices and improves privacy and offline access through selective synchronization. [1.1]',
      options: { maxPassagesPerSource: 5, maxPassageChars: 1200, claimAlignment: true },
    });
    assert.equal(result.passages.length, 1);
    assert.equal(result.claims.length, 1);
    assert.ok(result.claims[0].evidence[0].passageId);
    assert.equal(result.findings[0].evidenceStatus, 'direct_evidence');
  });

  it('never creates direct passages from snippets or failed reads', () => {
    const result = buildEvidenceArtifacts({
      query: 'evidence',
      findings: [{ question: 'evidence', sources: [
        { title: 'Snippet', url: 'https://snippet.test', snippet: 'Search-only evidence' },
        { title: 'Failed', url: 'https://failed.test', content: 'A body that was not successfully retrieved and must not become direct evidence.', fetchStatus: 'failed' },
      ] }],
      report: '# Summary\n\nA sufficiently detailed report statement about evidence handling.',
      options: { enabled: true, claimAlignment: true },
    });
    assert.equal(result.passages.length, 0);
    assert.equal(result.findings[0].evidenceStatus, 'search_snippet');
  });

  it('preserves the richest duplicate source record and prioritizes primary sources', () => {
    const pool = new SourceCandidatePool();
    pool.add({ title: 'Secondary overview', url: 'https://blog.csdn.net/example', snippet: 'overview' }, { query: 'open source framework architecture' });
    pool.add({ title: 'Official repository', url: 'https://github.com/example/project', snippet: 'source code' }, { query: 'open source framework architecture' });
    pool.add({ title: 'Official repository', url: 'https://github.com/example/project', content: 'Primary repository documentation with implementation details.', fetchStatus: 'ok', contentOrigin: 'fetched' }, { query: 'open source framework architecture' });
    const selected = pool.select({ enabled: true, maxPerHostname: 2 });
    assert.equal(selected[0].url, 'https://github.com/example/project');
    assert.equal(selected[0].sourceKind, 'primary');
    assert.match(selected[0].content, /implementation details/);
    assert.equal(selected[0].fetchStatus, 'ok');
  });

  it('does not classify generic developer-community articles as project primary sources', () => {
    const pool = new SourceCandidatePool();
    pool.add({ title: '2026 open source ecosystem overview', url: 'https://developer.example.com/articles/overview' }, { query: 'open source framework' });
    const [selected] = pool.select({ enabled: true });
    assert.equal(selected.sourceKind, 'secondary');
  });
});
