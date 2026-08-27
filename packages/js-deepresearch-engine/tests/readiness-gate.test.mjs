import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { inferResearchProfile } from '../src/research/adaptive/research-profile.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { evaluateAnswerReadiness } from '../src/research/adaptive/agent-policy.mjs';

describe('deterministic readiness gate', () => {
  it('keeps required or critical gaps from becoming evidence_sufficient', () => {
    const query = '智谱 港交所 招股书 营收 控股股东';
    const profile = inferResearchProfile(query);
    assert.ok(profile.flags.primary_source);
    assert.ok(profile.requiredHosts.includes('hkexnews.hk'));
    const gate = evaluateReadinessGate({
      query,
      profile,
      gaps: [{
        id: 'gap-1',
        question: query,
        status: 'open',
        priority: 'critical',
        requiredHosts: profile.requiredHosts,
        minIndependentSources: 2,
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [{
          title: 'Media reprint',
          url: 'https://finance.sina.com.cn/zhipu',
          content: 'Media reprint of revenue figures without the prospectus.',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'required_host_missing' || failure.code === 'critical_gap_open'));
  });

  it('does not treat same-domain reprints as two independent sources', () => {
    const query = 'Compare two local LLM tools for deployment';
    const gate = evaluateReadinessGate({
      query,
      profile: { flags: {}, minIndependentSources: 2 },
      gaps: [{ id: 'gap-1', question: query, status: 'body_read', priority: 'critical', requiredHosts: [] }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'https://news.example.com/one', content: 'First reprint of the same story with enough body text.', fetchStatus: 'ok' },
          { url: 'https://news.example.com/two', content: 'Second reprint of the same story with enough body text.', fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'independent_sources_short'));
  });

  it('does not let an LLM evaluator flip a failed gate to pass', async () => {
    const state = new ResearchState({
      query: '智谱 港交所 招股书 营收',
      maxSteps: 4,
    });
    state.findings.push({
      gapId: 'gap-1',
      sources: [{
        url: 'https://www.reuters.com/zhipu',
        content: 'Secondary coverage of listing rumors with enough body text.',
        fetchStatus: 'ok',
      }],
    });
    state.refreshBudgetView();
    assert.equal(state.readiness.pass, false);
    const evaluation = await evaluateAnswerReadiness({
      state,
      llm: {
        async complete() {
          return JSON.stringify({ pass: true, missingAspect: '' });
        },
      },
    });
    assert.equal(evaluation.llmPass, true);
    assert.equal(evaluation.pass, false);
    assert.equal(state.readiness.pass, false);
  });
});
