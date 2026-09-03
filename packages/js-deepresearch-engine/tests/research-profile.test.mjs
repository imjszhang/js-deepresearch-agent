import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inferResearchProfile,
  mergeProfilePlan,
  planResearchProfile,
  sanitizeEvidenceProfile,
} from '../src/research/adaptive/research-profile.mjs';

describe('research profile does not invent venue policy', () => {
  it('does not treat official docs as exchange filings', () => {
    const queries = [
      '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？',
      'Compare official docs of llama.cpp and Ollama',
      'OpenAI 官方 API 文档 rate limit',
      'Apple 官方 年报',
      '某公司投资尽调 监管披露 年报',
      '智谱 港交所 招股书 营收 控股股东',
    ];
    for (const query of queries) {
      const profile = inferResearchProfile(query);
      assert.deepEqual(profile.requiredHosts, []);
      assert.deepEqual(profile.preferredHosts, []);
      assert.deepEqual(profile.requiredSourceTypes, []);
      assert.equal(profile.flags.primary_source, false);
      assert.equal(profile.minIndependentSources, 1);
    }
  });

  it('extracts only hostnames written in the query', () => {
    const profile = inferResearchProfile('Read https://github.com/ggml-org/llama.cpp and docs.llamacpp.com');
    assert.deepEqual(profile.requiredHosts, ['github.com', 'docs.llamacpp.com']);
    assert.ok(!profile.requiredHosts.includes('hkexnews.hk'));
    assert.ok(!profile.requiredHosts.includes('sec.gov'));
  });

  it('does not treat llama.cpp as a hostname', () => {
    const profile = inferResearchProfile('What is llama.cpp official positioning?');
    assert.deepEqual(profile.requiredHosts, []);
  });

  it('lets an LLM commit hosts and drops invented non-host values', () => {
    const base = inferResearchProfile('智谱 港交所 招股书');
    const merged = mergeProfilePlan(base, {
      method: 'llm',
      flags: { primary_source: true, numeric: true },
      requiredHosts: ['hkexnews.hk', '港交所', 'annual report'],
      requiredSourceTypes: ['primary_filing', 'exchange'],
      minIndependentSources: 2,
    });
    assert.deepEqual(merged.requiredHosts, ['hkexnews.hk']);
    assert.deepEqual(merged.requiredSourceTypes, ['primary_filing']);
    assert.equal(merged.flags.primary_source, true);
    assert.equal(merged.minIndependentSources, 2);
    assert.ok(!merged.requiredHosts.includes('sec.gov'));
  });

  it('uses the LLM plan as the source of policy', async () => {
    const query = '智谱 港交所 招股书 营收';
    const profile = await planResearchProfile({
      query,
      profile: inferResearchProfile(query),
      llm: {
        async complete() {
          return JSON.stringify({
            flags: { primary_source: true },
            requiredHosts: ['hkexnews.hk'],
            preferredHosts: [],
            requiredSourceTypes: ['primary_filing'],
            minIndependentSources: 2,
            gaps: [{ question: 'Read the HKEX prospectus', priority: 'critical', requiredHosts: ['hkexnews.hk'] }],
          });
        },
      },
    });
    assert.deepEqual(profile.requiredHosts, []);
    assert.deepEqual(profile.preferredHosts, ['hkexnews.hk']);
    assert.deepEqual(profile.requiredSourceTypes, ['primary_filing']);
    assert.deepEqual(profile.plannedGaps[0].requiredHosts, []);
    assert.equal(profile.plannedGaps[0].preferredHosts[0], 'hkexnews.hk');
  });

  it('strips invented web hosts from local-only profiles', async () => {
    const settings = { search: { engine: 'local', local: { dirs: ['/notes'] } } };
    const query = '房产操作攻略';
    const profile = await planResearchProfile({
      query,
      settings,
      evidenceScope: 'local',
      profile: inferResearchProfile(query, { settings, evidenceScope: 'local' }),
      llm: {
        async complete() {
          return JSON.stringify({
            flags: { primary_source: true },
            requiredHosts: ['fang.com', 'sec.gov'],
            preferredHosts: ['ke.com'],
            requiredSourceTypes: ['primary_filing'],
            minIndependentSources: 4,
            gaps: [{ question: '哪个城市', requiredHosts: ['fang.com'] }],
          });
        },
      },
    });
    assert.deepEqual(profile.requiredHosts, []);
    assert.deepEqual(profile.preferredHosts, []);
    assert.ok(!profile.requiredSourceTypes.includes('primary_filing'));
    assert.equal(profile.minIndependentSources, 1);
    assert.deepEqual(profile.plannedGaps[0].requiredHosts, []);
    const kept = sanitizeEvidenceProfile({
      query: 'Read fang.com listings',
      requiredHosts: ['fang.com', 'sec.gov'],
      preferredHosts: ['ke.com'],
      requiredSourceTypes: ['primary_filing'],
      minIndependentSources: 3,
    }, {
      evidenceScope: 'local',
      settings: { search: { local: { dirs: ['/a', '/b'] } } },
      query: 'Read fang.com listings',
    });
    assert.deepEqual(kept.requiredHosts, ['fang.com']);
    assert.equal(kept.minIndependentSources, 2);
  });

  it('retries truncated planner JSON and accepts compact slots', async () => {
    let calls = 0;
    const query = 'Compare SubjectA and SubjectB using docs.example.com';
    const profile = await planResearchProfile({
      query,
      profile: inferResearchProfile(query),
      llm: {
        _meta: null,
        getLastCallMetadata() { return this._meta; },
        async complete() {
          calls += 1;
          if (calls === 1) {
            this._meta = { finishReason: 'length' };
            return '{"requiredAnswerSlots":[{"answerSlot":"SubjectA","question":"What is SubjectA';
          }
          this._meta = { finishReason: 'stop' };
          return JSON.stringify({
            requiredAnswerSlots: [{
              answerSlot: 'SubjectA',
              question: 'What is SubjectA official status?',
              evidenceCriteria: ['official document'],
            }],
          });
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(profile.contractUnavailable, false);
    assert.equal(profile.contractRetried, true);
    assert.equal(profile.brief.requiredAnswerSlots[0].answerSlot, 'SubjectA');
    assert.ok(!profile.requiredHosts.includes('hkexnews.hk'));
  });

  it('marks a double planner failure as contract_unavailable', async () => {
    const query = 'Open research question without a user brief';
    const profile = await planResearchProfile({
      query,
      profile: inferResearchProfile(query),
      llm: {
        getLastCallMetadata() { return { finishReason: 'length' }; },
        async complete() { return '{}'; },
      },
    });
    assert.equal(profile.contractUnavailable, true);
    assert.equal(profile.brief.requiredAnswerSlots.length, 0);
    assert.ok(['finish_reason_length', 'invalid_or_empty_json'].includes(profile.contractFailure));
  });

  it('retries when sanitization removes the apparent planner contract', async () => {
    let calls = 0;
    const query = 'SubjectA current status';
    const profile = await planResearchProfile({
      query,
      profile: inferResearchProfile(query),
      llm: {
        async complete() {
          calls += 1;
          if (calls === 1) {
            return JSON.stringify({ requiredHosts: ['not a hostname'] });
          }
          return JSON.stringify({
            requiredAnswerSlots: [{
              answerSlot: 'current status',
              question: 'What is SubjectA current status?',
            }],
          });
        },
      },
    });

    assert.equal(calls, 2);
    assert.equal(profile.contractRetried, true);
    assert.equal(profile.contractUnavailable, false);
    assert.equal(profile.brief.requiredAnswerSlots[0].answerSlot, 'current status');
  });

  it('lets the planner fill empty aliases and month-end asOf without promoting inferred hosts', async () => {
    const query = '截至2026年8月研究智谱AI与Zhipu AI的招股书';
    const profile = await planResearchProfile({
      query,
      profile: inferResearchProfile(query),
      llm: {
        async complete() {
          return JSON.stringify({
            entities: ['智谱AI'],
            entityAliases: ['Zhipu AI', '智谱'],
            asOf: '2026-08',
            requiredHosts: ['hkexnews.hk'],
            preferredHosts: ['hkexnews.hk'],
            requiredSourceTypes: ['primary_filing'],
            requiredAnswerSlots: [{
              answerSlot: 'ownership',
              question: '控股股东是谁',
              priority: 'critical',
            }],
          });
        },
      },
    });
    assert.deepEqual(profile.brief.entities, ['智谱AI']);
    assert.deepEqual(profile.brief.entityAliases, ['Zhipu AI', '智谱']);
    assert.equal(profile.brief.asOf.date, '2026-08-31');
    assert.equal(profile.brief.asOf.source, 'planner');
    assert.deepEqual(profile.requiredHosts, []);
    assert.ok(profile.preferredHosts.includes('hkexnews.hk'));
  });

  it('keeps user slots, aliases, and asOf over planner values', async () => {
    const query = 'Read docs.example.com for 智谱AI';
    const incoming = inferResearchProfile({
      query,
      entities: ['智谱AI'],
      entityAliases: ['用户别名'],
      asOf: '2026-07',
      requiredAnswerSlots: [{ answerSlot: 'status', question: 'Is SubjectA supported?' }],
    });
    const profile = await planResearchProfile({
      query,
      profile: incoming,
      llm: {
        async complete() {
          return JSON.stringify({
            entities: ['PlannerCo'],
            entityAliases: ['planner-alias'],
            asOf: '2025-01',
            requiredAnswerSlots: [{ answerSlot: 'planner-only', question: 'invented' }],
            requiredHosts: ['sec.gov'],
          });
        },
      },
    });
    assert.deepEqual(profile.brief.entities, ['智谱AI']);
    assert.deepEqual(profile.brief.entityAliases, ['用户别名']);
    assert.equal(profile.brief.asOf.date, '2026-07-31');
    assert.equal(profile.brief.requiredAnswerSlots[0].answerSlot, 'status');
  });

  it('keeps user slots when the planner returns a different contract', async () => {
    const query = 'Read docs.example.com for SubjectA';
    const incoming = inferResearchProfile({
      query,
      requiredAnswerSlots: [{ answerSlot: 'status', question: 'Is SubjectA supported?' }],
    });
    const profile = await planResearchProfile({
      query,
      profile: incoming,
      llm: {
        async complete() {
          return JSON.stringify({
            requiredAnswerSlots: [{ answerSlot: 'planner-only', question: 'invented' }],
            requiredHosts: ['sec.gov'],
          });
        },
      },
    });
    assert.equal(profile.brief.requiredAnswerSlots[0].answerSlot, 'status');
    assert.equal(profile.contractUnavailable, false);
    assert.ok(!profile.brief.requiredAnswerSlots.some((slot) => slot.answerSlot === 'planner-only'));
  });
});
