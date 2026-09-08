import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCanonicalObservability, summarizeScheduler } from '../src/research/observability.mjs';

test('canonical metrics separate retrieval snapshots, question associations and actual read attempts', () => {
  const source = { url: 'https://example.org/doc', documentVersionId: 'v1', retrievedAt: '2026-09-08T00:00:00Z',
    fetchStatus: 'ok', assessment: { readability: 'readable' } };
  const findings = [{ sources: [source] }, { sources: [{ ...source }] },
    { origin: 'document_reuse', sources: [{ ...source, retrievedAt: undefined }] },
    { sources: [{ ...source, documentVersionId: 'v2', retrievedAt: '2026-09-08T01:00:00Z' }] },
    { sources: [{ url: 'https://example.org/blocked', fetchStatus: 'failed', fetchErrorType: 'http_4xx' }] }];
  const metrics = collectCanonicalObservability({ findings, sourceReadAttempts: 4,
    trace: [{ action: 'search', outcome: 'useful' }, { action: 'search', status: 'success' }],
    previous: { transport: { blockedHosts: ['example.org'] } } });
  assert.equal(metrics.transport.sourceReadAttempts, 4);
  assert.equal(metrics.transport.scope, 'unique_retrieval_snapshots');
  assert.equal(metrics.transport.fetchAttempted, 3);
  assert.equal(metrics.transport.fetchOk, 2);
  assert.deepEqual(metrics.transport.fetchBlocked, { http_4xx: 1 });
  assert.deepEqual(metrics.transport.blockedHosts, ['example.org']);
  assert.equal(metrics.sourceAssessment.count, 2);
  assert.deepEqual(metrics.queryOutcomes, { useful: 1 });
});

test('scheduler metrics retain outcomes and scoped failures without duplicating execution state', () => {
  const metrics = summarizeScheduler({ round: 3, maxFailures: 3,
    actions: [{ type: 'search', status: 'completed', inputRefs: { query: 'private query' } }, { type: 'inspect_document', status: 'failed' }],
    receipts: [{ outcome: { execution: 'failed', retryable: true } }, { outcome: { execution: 'succeeded' } }],
    appliedReceiptIds: ['r1', 'r2'], plannerFailures: [['scope1', 3], ['scope2', 1]], noChangeCycles: 2,
    terminal: { reason: 'safety_cap', detail: 'action_frontier_exhausted' } });
  assert.equal(metrics.dispatchedAttempts, 3);
  assert.deepEqual(metrics.actionsByType, { search: 1, inspect_document: 1 });
  assert.equal(metrics.retryableFailures, 1);
  assert.equal(metrics.sealedPlannerScopes, 1);
  assert.equal(metrics.appliedReceiptCount, 2);
  assert.equal(metrics.terminal.detail, 'action_frontier_exhausted');
  assert.equal(metrics.actions, undefined);
  assert.doesNotMatch(JSON.stringify(metrics), /private query|scope1|inputRefs/);
});
