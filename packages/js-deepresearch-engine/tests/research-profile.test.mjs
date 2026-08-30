import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inferResearchProfile,
  mergeProfilePlan,
  planResearchProfile,
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
    assert.deepEqual(profile.requiredHosts, ['hkexnews.hk']);
    assert.deepEqual(profile.requiredSourceTypes, ['primary_filing']);
    assert.equal(profile.plannedGaps[0].requiredHosts[0], 'hkexnews.hk');
  });
});
