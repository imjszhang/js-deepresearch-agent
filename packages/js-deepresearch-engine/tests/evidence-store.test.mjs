import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../src/research/evidence-store.mjs';
import { splitContentForPassages } from '../src/research/passage-utils.mjs';
const body = 'The package is distributed under a permissive license. '.repeat(10);
const source = (content = body) => ({ url: 'https://docs.example.org/tool', content, fetchStatus: 'ok' });

test('document versions and range IDs are immutable; associations do not duplicate bodies', () => {
  const store = new EvidenceStore();
  const one = store.register(source(), 'a');
  assert.equal(store.register(source(), 'b'), one);
  const two = store.register(source(`${body}Changed license.`), 'c');
  assert.notEqual(one.documentVersionId, two.documentVersionId);
  assert.equal(store.documents.size, 1);
  assert.equal(store.versions.size, 2);
  assert.equal(store.associations.size, 3);
  const p = store.addPassage(one.documentVersionId, 0, 53);
  const q = store.addPassage(one.documentVersionId, 54, 107);
  assert.notEqual(p.id, q.id);
  assert.throws(() => store.register({ ...source('different'), documentVersionId: one.documentVersionId }), /changed/);
  assert.throws(() => store.addPassage(one.documentVersionId, -1, 2), /range/);
  assert.equal(store.register({ ...source(), fetchStatus: 'failed' }), null);
  assert.equal(store.register({ url: 'https://other.example.org', summary: body }), null);
});

test('inspection verdict is scoped to exact versions and checked ranges, with independent export', () => {
  const store = new EvidenceStore();
  const version = store.register(source(), 'a');
  const passages = store.chunks(version.documentVersionId, 100);
  store.recordInspection({ taskId: 'a', documentVersionId: version.documentVersionId, passageIds: [passages[0].id], verdict: 'checked_without_support' });
  assert.equal(store.checked('a', passages[0]), true);
  assert.equal(store.checked('b', passages[0]), false);
  assert.equal(store.checked('a', passages.at(-1)), false);
  const copy = new EvidenceStore(JSON.parse(JSON.stringify(store.export())));
  assert.equal(copy.body(version.documentVersionId), body);
  assert.equal(copy.checked('a', passages[0]), true);
  const corrupt = store.export();
  corrupt.documentsByHash[version.bodyHash] = 'invalid';
  assert.throws(() => new EvidenceStore(corrupt), /hash mismatch/);
});

test('sentence-aware overlapping chunks preserve a boundary fact and exact UTF-16 anchors', () => {
  const content = `# Title\n${'x'.repeat(88)}\nThe software uses the Example License.\n${'word '.repeat(100)}😀`;
  const chunks = splitContentForPassages(content, 120);
  assert.ok(chunks.some((chunk) => chunk.text.includes('The software uses the Example License.')));
  assert.ok(chunks.every((chunk) => content.slice(chunk.startChar, chunk.endChar) === chunk.text));
});

test('chunk ends and overlapping starts never split surrogate pairs', () => {
  for (let prefix = 0; prefix < 48; prefix++) {
    const content = `${'x'.repeat(prefix)}${'🌼'.repeat(100)}`;
    const chunks = splitContentForPassages(content, 32);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.equal(chunk.text, content.slice(chunk.startChar, chunk.endChar));
      assert.equal(Buffer.from(chunk.text).toString('utf8'), chunk.text);
    }
    for (let i = 0; i < content.length; i++) {
      assert.ok(chunks.some((chunk) => chunk.startChar <= i && chunk.endChar > i));
    }
  }
});

test('unfinished legacy migration freezes hard criteria and only reanchors actual body quotes', async () => {
  const { migrateUnfinishedLegacyState } = await import('../src/research/legacy-state-migration.mjs');
  const quote = 'The package is distributed under a permissive license.';
  const old = { schemaVersion: 1, query: 'license', brief: { requiredAnswerSlots: [{ id: 'license', evidenceCriteria: ['mainstream_media'] }] },
    findings: [{ gapId: 'a', sources: [source()] }, { gapId: 'b', sources: [{ url: 'https://summary.org', summary: quote }] }],
    gaps: ['a', 'b'].map((id) => ({ id, requiredSlot: true, evidenceCriteria: ['mainstream_media'], slotSupport: { quote, quoteAnchored: true, verdict: 'supported' } })), budget: { usage: { llmTokens: 123 } } };
  const migrated = migrateUnfinishedLegacyState(old);
  assert.equal(migrated.executionVersion, 2);
  assert.deepEqual(migrated.gaps[0].evidenceCriteria, ['mainstream_media']);
  assert.equal(migrated.gaps[0].origin, 'legacy_unknown');
  assert.equal(migrated.gaps[0].slotSupport.quoteAnchored, true);
  assert.equal(migrated.gaps[1].slotSupport.quoteAnchored, false);
  assert.equal(migrated.budget.usage.llmTokens, 123);
  assert.equal(old.schemaVersion, 1);
});

test('local inspection advances across unseen ranges to find a license without a new search', async () => {
  const { judgeOpenSlotSupport, applySlotSupportJudgments } = await import('../src/research/gap-slot-support.mjs');
  const license = 'The software is distributed under the Example License.';
  const content = `${'Deployment instructions. '.repeat(95)}\n\n${'Interface documentation. '.repeat(95)}\n\n${license}`;
  const store = new EvidenceStore();
  const findings = [{ gapId: 'gap-license', sources: [source(content)] }];
  store.captureFindings(findings);
  const gap = { id: 'gap-license', question: '许可证是什么', requiredSlot: true, status: 'open' };
  let inspections = 0;
  const llm = { async complete({ purpose, messages }) {
    assert.equal(purpose, 'gap_support'); inspections++;
    const found = messages.at(-1).content.includes(license);
    return JSON.stringify({ judgments: [{ gapId: gap.id, verdict: found ? 'supported' : 'unsupported', quote: found ? license : '', answer: found ? 'Example License' : '', missingFacets: found ? [] : ['许可证类型'] }] });
  } };
  for (let attempt = 0; attempt < 5 && !gap.slotSupport?.quoteAnchored; attempt++) {
    const support = await judgeOpenSlotSupport({ llm, query: gap.question, gaps: [gap], findings, evidenceStore: store, inspectUnseen: true, topK: 1 });
    applySlotSupportJudgments([gap], support.judgments);
  }
  assert.equal(gap.slotSupport?.verdict, 'supported');
  assert.ok(inspections >= 2);
  assert.equal(store.versions.size, 1);
  assert.ok([...store.inspections.values()].some((item) => item.verdict === 'checked_without_support'));
  assert.ok([...store.inspections.values()].some((item) => item.verdict === 'supported'));
});

test('counter-evidence inspection compares the prior answer and preserves both document anchors', async () => {
  const { judgeOpenSlotSupport } = await import('../src/research/gap-slot-support.mjs');
  const oldText = 'Atlas supports Windows and Linux for local document processing.';
  const newText = 'Atlas supports Linux only. Windows is not supported in this release.';
  const store = new EvidenceStore();
  const findings = [{ gapId: 'platform', sources: [source(oldText), source(newText)] }];
  store.captureFindings(findings);
  const [oldVersion, newVersion] = [...store.versions.values()];
  const prior = store.chunks(oldVersion.documentVersionId)[0];
  store.recordInspection({ taskId: 'platform', documentVersionId: oldVersion.documentVersionId, passageIds: [prior.id], verdict: 'supported' });
  const gap = { id: 'platform', requiredSlot: true, question: 'Which platforms support Atlas?', status: 'verified',
    slotSupport: { verdict: 'supported', answer: oldText, quote: oldText, quoteAnchored: true, supportingPassageIds: [prior.id] } };
  const support = await judgeOpenSlotSupport({ query: gap.question, gaps: [gap], findings, evidenceStore: store, inspectUnseen: true,
    llm: { async complete({ messages }) {
      assert.ok(messages.at(-1).content.includes('Previous evaluated answer'));
      assert.ok(messages.at(-1).content.includes(oldText));
      return JSON.stringify({ judgments: [{ gapId: gap.id, verdict: 'conflicting', answer: 'The versions disagree about Windows support.', quote: newText }] });
    } } });
  const judgment = support.judgments[0];
  assert.equal(judgment.verdict, 'conflicting');
  assert.ok(judgment.supportingPassageIds.includes(prior.id));
  assert.ok(judgment.contradictingPassageIds.some(id=>store.passages.get(id).documentVersionId===newVersion.documentVersionId));
  assert.ok([...store.inspections.values()].some(item=>item.verdict==='contradicted'));
});

test('observed redirects retain the original URL while identical reposts keep separate source identities', () => {
  const store = new EvidenceStore();
  const first = store.register({ ...source(), url: 'https://docs.example.org/current', finalUrl: 'https://docs.example.org/current', originalUrl: 'https://docs.example.org/old' });
  assert.equal(store.register({ ...source(), url: first.url }).documentVersionId, first.documentVersionId);
  assert.ok(store.documents.get(first.sourceId).redirectAliases.includes('https://docs.example.org/old'));
  const repost = store.register({ ...source(), url: 'https://mirror.example.org/tool' });
  assert.notEqual(repost.sourceId, first.sourceId);
  assert.notEqual(repost.documentVersionId, first.documentVersionId);
  assert.equal(repost.bodyHash, first.bodyHash);
  assert.equal(store.bodies.size, 1);
});

test('a narrower local inspection cannot erase prior complete support, but anchored conflict can', async () => {
  const { applySlotSupportJudgments } = await import('../src/research/gap-slot-support.mjs');
  const gap = { id: 'license-price', slotSupport: { verdict: 'supported', method: 'llm', quoteAnchored: true,
    quote: body, answer: 'The license and price are both documented.', supportingPassageIds: ['old'], evidenceSourceIds: ['source-old'] } };
  const partial = { gapId: gap.id, verdict: 'partially_supported', method: 'llm', quoteAnchored: true, quote: 'Only the license is described here.',
    answer: 'This selected range discusses licensing.', supportingPassageIds: ['new'], evidenceSourceIds: ['source-new'], inspectionScope: 'selected_ranges' };
  applySlotSupportJudgments([gap], [partial]);
  assert.equal(gap.slotSupport.verdict, 'supported');
  assert.equal(gap.slotSupport.answer, 'The license and price are both documented.');
  assert.deepEqual(gap.slotSupport.supportingPassageIds, ['old']);
  applySlotSupportJudgments([gap], [{ ...partial, verdict: 'conflicting' }]);
  assert.equal(gap.slotSupport.verdict, 'conflicting');
});

test('local negative or partial inspections retain prior answers with accurate new-range coverage', async () => {
  const { judgeOpenSlotSupport, applySlotSupportJudgments } = await import('../src/research/gap-slot-support.mjs');
  for (const verdict of ['unsupported', 'partially_supported']) {
    const oldText = 'The package uses the Example License and is free to download.';
    const newText = verdict === 'unsupported' ? 'The website navigation contains a search box and a contact link.' : 'Downloading the application does not require a payment.';
    const store = new EvidenceStore();
    const findings = [{ gapId: 'terms', sources: [source(oldText), source(newText)] }];
    store.captureFindings(findings);
    const [oldVersion, newVersion] = [...store.versions.values()];
    const previous = store.chunks(oldVersion.documentVersionId)[0];
    store.recordInspection({ taskId: 'terms', documentVersionId: oldVersion.documentVersionId, passageIds: [previous.id], verdict: 'supported' });
    const gap = { id: 'terms', question: 'What are the license and price?', requiredSlot: true, status: 'verified',
      slotSupport: { verdict: 'supported', method: 'llm', answer: oldText, quote: oldText, quoteAnchored: true, supportingPassageIds: [previous.id] } };
    const result = await judgeOpenSlotSupport({ query: gap.question, gaps: [gap], findings, evidenceStore: store, inspectUnseen: true,
      llm: { async complete({ messages }) {
        assert.match(messages[0].content, /verdict describes this inspection/);
        return JSON.stringify({ judgments: [{ gapId: gap.id, verdict, quote: verdict === 'unsupported' ? '' : newText, answer: newText }] });
      } } });
    assert.equal(result.unknown, false);
    applySlotSupportJudgments([gap], result.judgments);
    assert.equal(gap.slotSupport.answer, oldText);
    assert.equal(gap.slotSupport.verdict, 'supported');
    const inspection = [...store.inspections.values()].find(item=>item.documentVersionId===newVersion.documentVersionId);
    assert.equal(inspection.verdict, verdict === 'unsupported' ? 'checked_without_support' : 'supported');
  }
});

test('canonical report preparation reuses ranges without external ranking or fabricated inspections', async () => {
  const { buildPassageArtifactsAsync } = await import('../src/research/evidence-chain.mjs');
  const store = new EvidenceStore();
  const findings = [{ gapId: 'license', question: '许可证', sources: [source()] },
    { gapId: 'price', question: '费用', sources: [source()] }];
  store.captureFindings(findings);
  const version = [...store.versions.values()][0];
  const knownIds = store.chunks(version.documentVersionId).map(p=>p.id);
  const result = await buildPassageArtifactsAsync({ query: 'Assess the tool', findings, options: { evidenceStore: store,
    embedding: { async embedDocuments() { assert.fail('Report preparation must consume canonical evidence without external ranking'); } } } });
  assert.ok(result.passages.length);
  assert.ok(result.passages.every(p=>knownIds.includes(p.id)));
  assert.ok(result.passages.every(p=>p.findingIds.length===2));
  assert.equal(store.inspections.size, 0);
});

test('cumulative answers keep explicitly used old evidence without accumulating unrelated references', async () => {
  const { judgeOpenSlotSupport } = await import('../src/research/gap-slot-support.mjs');
  const texts = ['The package uses the Example License for every software release.',
    'The documentation website has a blue navigation panel and a search button.',
    'The software download is free; hosted model services have separate charges.'];
  const store = new EvidenceStore();
  const findings = [{ gapId: 'terms', sources: texts.map(text=>source(text)) }];
  store.captureFindings(findings);
  const passages = [...store.versions.values()].map(version=>store.chunks(version.documentVersionId)[0]);
  for (const passage of passages.slice(0,2)) store.recordInspection({ taskId: 'terms', documentVersionId: passage.documentVersionId, passageIds: [passage.id], verdict: 'supported' });
  const gap = { id: 'terms', requiredSlot: true, question: 'What are the license and price?', status: 'body_read',
    slotSupport: { verdict: 'partially_supported', quoteAnchored: true, quote: texts[0], answer: 'The license is known; pricing needs checking.', supportingPassageIds: passages.slice(0,2).map(p=>p.id) } };
  const support = await judgeOpenSlotSupport({ query: gap.question, gaps: [gap], findings, evidenceStore: store, inspectUnseen: true,
    llm: { async complete() { return JSON.stringify({ judgments: [{ gapId: gap.id, verdict: 'supported', answer: 'Example License; free download with separate model service charges.', quote: texts[2], supportingPassageIds: [passages[0].id] }] }); } } });
  assert.deepEqual(new Set(support.judgments[0].supportingPassageIds), new Set([passages[0].id, passages[2].id]));
});
