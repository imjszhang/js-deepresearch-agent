import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerContentFetchHandler, resetContentFetchHandlers } from '../src/research/content-resolver.mjs';
import { enrichFindings } from '../src/research/source-enricher.mjs';
import { slotSupportFingerprint } from '../src/research/gap-slot-support.mjs';
import { createResearchProviders } from '../src/index.mjs';

afterEach(() => resetContentFetchHandlers());

const BODY = 'Acme Corp published its annual compliance filing describing algorithm registration and data security work in detail.';

function choice(label, probability, labels) {
  const rest = labels.filter((item) => item !== label);
  const probabilities = Object.fromEntries(labels.map((item) => [item, item === label ? probability : (1 - probability) / rest.length]));
  return { type: 'choice', choice: label, probabilities, confidence: probability };
}

const FORUM = { contentKind: 'forum', publisherType: 'ugc', evidenceTier: 'ugc' };
const OFFICIAL = { contentKind: 'filing', publisherType: 'official', evidenceTier: 'other_primary' };

function answersFor(questions, { readability = ['readable', 0.95], firstParty = 0.05, confidence = 0.9, pick = FORUM } = {}) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: firstParty }];
    const labels = Object.keys(question.criteria);
    if (id === 'readability') return [id, choice(readability[0], readability[1], labels)];
    return [id, choice(pick[id], confidence, labels)];
  }));
}

function jevProviders(handler, features = { sourceAssessment: true }, extra = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return handler(body, calls.length);
  };
  const providers = createResearchProviders({ judge: { provider: 'jev', apiKey: 'k-test', fetch, features, ...extra } });
  return { judge: providers.judge, calls };
}

function ok(body) {
  return new globalThis.Response(JSON.stringify(body), { status: 200 });
}

const llmAssessment = JSON.stringify({ summary: 'LLM', readability: 'readable', contentKind: 'article', publisherType: 'mainstream_media', firstParty: false, evidenceTier: 'mainstream', reason: 'llm' });

async function enrich({ judge, fetchMode = 'full', url = 'https://acme.example/filing', assessmentEnabled = true, llmCalls = { value: 0 } } = {}) {
  registerContentFetchHandler(async () => ({ status: 'ok', title: 'Acme filing', content: BODY }));
  const [finding] = await enrichFindings([{ gapId: 'gap-1', question: 'Acme compliance', sources: [{ url, title: 'Acme filing' }] }], {
    query: 'Acme compliance',
    fetchMode,
    maxUrlsPerIteration: 1,
    maxUrlsTotal: 1,
    maxContentChars: 8000,
    enrichConcurrency: 1,
    llm: { async complete() { llmCalls.value += 1; return llmAssessment; } },
    settings: { research: { read: { sourceAssessment: { enabled: assessmentEnabled } } } },
    entities: ['Acme'],
    budget: { claim() {}, canClaim() { return true; } },
    judge,
  });
  return finding.sources[0];
}

test('confident Jev answers fill the existing assessment enums in full and extract modes without an LLM call', async () => {
  for (const fetchMode of ['full', 'extract']) {
    const { judge, calls } = jevProviders((body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions), usage: { input_tokens: 10, output_tokens: 1 } }));
    const llmCalls = { value: 0 };
    const source = await enrich({ judge, fetchMode, llmCalls });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'jev-1.13.0');
    assert.equal(llmCalls.value, 0);
    assert.equal(source.fetchStatus, 'ok');
    assert.equal(source.assessmentStatus, 'ok');
    assert.deepEqual({ ...source.assessment }, {
      summary: '', readability: 'readable', contentKind: 'forum', publisherType: 'ugc', firstParty: false,
      evidenceTier: 'ugc', reason: null, method: 'jev', judge: 'jev:typesafe:jev-1.13.0',
    });
    assert.equal(source.assessmentJudge.outcome, 'applied');
    assert.equal(source.content, BODY);
  }
});

test('[V26] degraded, uncertain or credential-granting Jev verdicts fall back to the original LLM assessment and keep the fetched body', async () => {
  const cases = [
    () => new globalThis.Response('busy', { status: 503 }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { confidence: 0.5 }), usage: {} }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { firstParty: 0.5 }), usage: {} }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { readability: ['unreadable', 0.85] }), usage: {} }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { pick: OFFICIAL }), usage: {} }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { firstParty: 0.95 }), usage: {} }),
    (body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { pick: { ...FORUM, publisherType: 'mainstream_media' } }), usage: {} }),
  ];
  for (const handler of cases) {
    const { judge } = jevProviders(handler);
    const llmCalls = { value: 0 };
    const source = await enrich({ judge, llmCalls });
    assert.equal(llmCalls.value, 1);
    assert.equal(source.assessment.method, 'llm');
    assert.equal(source.fetchStatus, 'ok');
    assert.equal(source.content, BODY);
    assert.equal(source.bodyQuality, undefined);
    assert.ok(['degraded', 'uncertain', 'credential_needs_llm'].includes(source.assessmentJudge.outcome));
  }
});

test('only a confident Jev unreadable verdict writes bodyQuality and never touches fetchStatus or the body', async () => {
  const { judge } = jevProviders((body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions, { readability: ['unreadable', 0.97] }), usage: {} }));
  const source = await enrich({ judge });
  assert.equal(source.fetchStatus, 'ok');
  assert.equal(source.bodyQuality, 'waf');
  assert.equal(source.content, BODY);
  assert.equal(source.assessment.method, 'jev');
});

test('[V26] summary mode, disabled switches and local corpus files never send the body to Jev', async () => {
  const { judge, calls } = jevProviders((body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions), usage: {} }));
  const summary = await enrich({ judge, fetchMode: 'summary' });
  assert.equal(summary.assessment.method, 'llm');
  await enrich({ judge, assessmentEnabled: false });
  const off = jevProviders(() => assert.fail('feature switch is off'), { readPriority: true });
  assert.equal((await enrich({ judge: off.judge })).assessment.method, 'llm');
  const local = await enrich({ judge, url: 'file:///corpus/acme.md' });
  assert.equal(local.assessment.method, 'llm');
  assert.equal(local.assessmentJudge.outcome, 'skipped_local_corpus');
  assert.equal(calls.length, 0);
  const allowed = jevProviders((body) => ok({ model: 'jev-1.13.0', answers: answersFor(body.questions), usage: {} }), { sourceAssessment: true }, { allowLocalCorpus: true });
  assert.equal((await enrich({ judge: allowed.judge, url: 'file:///corpus/acme.md' })).assessment.method, 'jev');
  assert.equal(allowed.calls.length, 1);
});

test('slot support fingerprints include the judge only for Jev-sourced assessments', () => {
  const gap = { id: 'gap-1', question: 'q' };
  const base = { id: 'p1', text: 'x', assessment: { firstParty: true, publisherType: 'official', contentKind: 'filing', evidenceTier: 'other_primary', method: 'llm' } };
  const llmPrint = slotSupportFingerprint(gap, [base]);
  assert.equal(slotSupportFingerprint(gap, [{ ...base, assessment: { ...base.assessment, method: 'fail_closed' } }]), llmPrint);
  assert.notEqual(slotSupportFingerprint(gap, [{ ...base, assessment: { ...base.assessment, method: 'jev', judge: 'jev:typesafe:jev-1.13.0' } }]), llmPrint);
});
