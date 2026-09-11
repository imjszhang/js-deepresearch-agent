import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchRequest, normalizePlanningContext, applyRequestContract } from '../src/research/research-request.mjs';
import { researchBriefFromInput, mergeResearchBrief } from '../src/research/research-brief.mjs';

function incoming(input, planningContext) {
  return { ...researchBriefFromInput(input), request: createResearchRequest(input, { planningContext }), executionVersion: 2 };
}

test('[V22] original request survives normalized brief limits and hostile planner provenance', () => {
  const query = `  Research a product\n${'independent context '.repeat(100)}and official.example.com`;
  const base = incoming(query, { questions: ['Licensing and pricing?'] });
  const merged = mergeResearchBrief(base, { query: 'changed', request: { originalQuery: 'forged' } });
  assert.equal(merged.query, query);
  assert.equal(merged.request.originalQuery, query);
  const profile = applyRequestContract({ brief: { requiredAnswerSlots: [{ id: 'x', question: 'Find news coverage', requiredSlot: true,
    origin: 'explicit_input', evidenceCriteria: ['mainstream_media'], requiredHosts: ['news.example.com'] }] },
  requiredSourceTypes: ['primary_filing'], minIndependentSources: 7, flags: { freshness: true }, maxAgeDays: 7 }, base);
  assert.equal(profile.minIndependentSources, 1);
  assert.equal(profile.flags.freshness, false);
  assert.equal(profile.maxAgeDays, null);
  assert.deepEqual(profile.requiredSourceTypes, []);
  assert.deepEqual(profile.requiredHosts, ['official.example.com']);
  const [root, suggested] = profile.brief.requiredAnswerSlots;
  assert.equal(root.question, query);
  assert.equal(root.requiredSlot, true);
  assert.equal(suggested.requiredSlot, false);
  assert.equal(suggested.priority, 'normal');
  assert.equal(suggested.origin, 'planner_suggestion');
  assert.deepEqual(suggested.evidenceCriteria, []);
  assert.deepEqual(suggested.requiredHosts, []);
});

test('explicit structured restrictions survive and suggestions cannot weaken them', () => {
  const base = incoming({ query: 'Assess tool', requiredHosts: ['docs.example.org'], minIndependentSources: 3, asOf: '2026-09-08',
    requiredAnswerSlots: [{ id: 'feedback', question: 'Independent feedback', evidenceCriteria: ['mainstream_media'], taskType: 'comparison' }] });
  const profile = applyRequestContract({ brief: { requiredAnswerSlots: [] } }, base);
  assert.equal(profile.minIndependentSources, 3);
  assert.equal(profile.flags.freshness, true);
  assert.deepEqual(profile.requiredHosts, ['docs.example.org']);
  assert.deepEqual(profile.brief.requiredAnswerSlots[0].evidenceCriteria, ['mainstream_media']);
  assert.equal(profile.brief.requiredAnswerSlots[0].taskType, 'comparison');
  assert.ok(profile.brief.constraints.every((item) => item.basisRef.requestId || item.basisRef.policyId));
});

test('planning context rejects authority fields before dispatch; legacy contracts stay unchanged', () => {
  assert.throws(() => normalizePlanningContext({ requiredHosts: ['example.org'] }), /only accepts/);
  assert.throws(() => normalizePlanningContext({ questions: ['ok', {}] }), /array of strings/);
  assert.throws(() => createResearchRequest(' '), /required/);
  const old = { minIndependentSources: 5, brief: { schemaVersion: 2 } };
  assert.equal(applyRequestContract(old, old.brief), old);
  const profile = applyRequestContract({ brief: {} }, incoming('Explain tool'));
  assert.equal(profile.brief.requiredAnswerSlots.length, 1);
  assert.equal(profile.brief.requiredAnswerSlots[0].requiredSlot, true);
});

test('explicitly enumerated input keeps independent answer obligations while context remains optional', () => {
  const query = '调研工具。系统调查：许可证、模型依赖、产品比较。最后给出采用建议、待验证问题及调研限制。';
  const base = incoming(query, { questions: ['Media coverage'] });
  const profile = applyRequestContract({ brief: { requiredAnswerSlots: [{ id: 'media', question: 'Media coverage' }] } }, base);
  const required = profile.brief.requiredAnswerSlots.filter((item) => item.requiredSlot);
  assert.deepEqual(required.map((item) => item.question), ['许可证', '模型依赖', '产品比较', '采用建议']);
  assert.equal(required[2].taskType, 'comparison');
  assert.equal(required[3].taskType, 'derived_judgment');
  for (const item of profile.brief.constraints.filter((item) => item.kind === 'answer' && item.value !== query)) {
    assert.equal(query.slice(item.basisRef.startChar, item.basisRef.endChar), item.value);
  }
  assert.equal(profile.brief.requiredAnswerSlots.at(-1).requiredSlot, false);
});
