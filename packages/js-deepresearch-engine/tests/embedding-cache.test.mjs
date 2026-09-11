import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheEmbedding } from '../src/research/embedding-cache.mjs';
import { rankPassages } from '../src/research/passage-selector.mjs';
import { createResearchProviders } from '../src/research/research-providers.mjs';
import { FileRunRecorder } from '../src/research/run-recorder.mjs';

test('shared document blocks across questions and concurrent requests embed once and resume from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-vectors-'));
  const calls = [];
  let active = 0, peak = 0;
  const provider = { provider: 'fixture', model: 'v1', async embedDocuments(texts) {
    calls.push(...texts); peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; return texts.map((text) => [text.length, 1]);
  } };
  try {
    const embedding = cacheEmbedding(provider, { sessionDir: dir });
    const content = 'Shared documentation describes the license. '.repeat(20);
    await Promise.all(['license', 'pricing', 'deployment'].map((query) => rankPassages({ query, content, embedding, chunkChars: 150 })));
    const documentInputs = calls.filter((text) => !['license', 'pricing', 'deployment'].includes(text));
    assert.equal(documentInputs.length, new Set(documentInputs).size);
    assert.ok(peak <= 2);
    const before = calls.length;
    await rankPassages({ query: 'license', content, embedding: cacheEmbedding(provider, { sessionDir: dir }), chunkChars: 150 });
    assert.equal(calls.length, before);
    await cacheEmbedding({ ...provider, model: 'v2' }, { sessionDir: dir }).embedDocuments(['license']);
    assert.equal(calls.length, before + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed vectors can retry and cancellation/budget failures propagate', async () => {
  let attempts = 0;
  const embedding = cacheEmbedding({ async embedDocuments(texts) {
    if (++attempts === 1) throw new Error('temporary');
    return texts.map(() => [1, 2]);
  } });
  await assert.rejects(embedding.embedDocuments(['doc']), /temporary/);
  assert.deepEqual(await embedding.embedDocuments(['doc']), [[1, 2]]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(embedding.embedDocuments(['doc'], { signal: controller.signal }), { name: 'AbortError' });
  const budget = cacheEmbedding({ async embedDocuments() { throw Object.assign(new Error('budget'), { name: 'BudgetExceededError' }); } });
  await assert.rejects(rankPassages({ query: 'q', content: 'A meaningful document about q.', embedding: budget }), { name: 'BudgetExceededError' });
});

test('one question vector is reused across documents with different titles', async () => {
  const calls = [];
  const embedding = cacheEmbedding({ provider: 'fixture', model: 'fixed', async embedDocuments(texts, options) {
    calls.push({ texts, purpose: options.purpose });
    return texts.map(text=>[text.length, 1]);
  } });
  for (const title of ['License reference', 'Pricing reference']) {
    await rankPassages({ query: 'Assess Atlas', question: 'license and price', title,
      content: `${title}: Atlas is a local document processing tool.`, embedding });
  }
  const questions = calls.filter(call=>call.purpose==='evidence_question').flatMap(call=>call.texts);
  assert.deepEqual(questions, ['Assess Atlas license and price']);
  assert.equal(calls.filter(call=>call.purpose==='evidence_passages').flatMap(call=>call.texts).length, 2);
});

test('provider resume advances embedding call IDs without overwriting previous requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-embedding-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recorder = new FileRunRecorder({ sessionDir: dir, strategy: 'exploratory', query: 'Atlas' });
  recorder.callStarted({ callId: 'embedding-17', kind: 'embedding', purpose: 'evidence_passages', request: { texts: ['original'] } });
  const original = fs.readFileSync(path.join(dir, 'calls/embedding-17.request.json'));
  const { embedding } = createResearchProviders({ embedding: { async embedDocuments(texts) { return texts.map(() => [1, 2]); } } }, { recorder: FileRunRecorder.reopen(dir) });
  await embedding.embedDocuments(['new input']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'calls/embedding-17.request.json')), original);
  assert.ok(fs.existsSync(path.join(dir, 'calls/embedding-18.request.json')));
});
