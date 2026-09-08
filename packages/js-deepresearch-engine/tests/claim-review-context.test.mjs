import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../src/research/evidence-store.mjs';
import { selectClaimReviewContext } from '../src/research/claim-review-context.mjs';

test('claim comparison retrieves existing canonical ranges from other documents without changing evidence', async () => {
  const store = new EvidenceStore();
  const docs = ['Install Atlas using pip.', 'Install Atlas using the desktop installer.', 'An unrelated article about weather.'];
  const passages = docs.map((content, index) => {
    const version = store.register({ url: `https://example.com/${index}`, content, fetchStatus: 'ok' });
    return store.addPassage(version.documentVersionId, 0, content.length);
  });
  const graph = { records: [{ claimId: 'claim-a', proposition: docs[0], supportRefs: [{ passageId: passages[0].id, documentVersionId: passages[0].documentVersionId }] }], bindings: [{ claimId: 'claim-a', taskId: 'install' }] };
  const before = store.export();
  const context = await selectClaimReviewContext({ graph, store, gaps: [{ id: 'install', question: 'Install Atlas' }], topK: 1 });
  assert.deepEqual(context.get('claim-a'), [passages[1]]);
  assert.deepEqual(store.export(), before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectClaimReviewContext({ graph, store, signal: controller.signal,
    embedding: { async embedDocuments() { controller.signal.throwIfAborted(); } } }), { name: 'AbortError' });
});
