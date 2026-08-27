import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { inferResearchProfile } from '../src/research/adaptive/research-profile.mjs';

describe('readiness gate', () => {
  it('does not pass when a required host was never read', () => {
    const query = 'Investment due diligence on a HKEX listed issuer using hkexnews.hk annual reports';
    const profile = inferResearchProfile(query);
    const gate = evaluateReadinessGate({
      query,
      profile,
      gaps: [{
        id: 'gap-1',
        question: query,
        status: 'body_read',
        priority: 'critical',
        requiredHosts: ['hkexnews.hk'],
        requiredSourceTypes: ['primary'],
        minIndependentSources: 2,
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [{
          url: 'https://media.example/reprint',
          title: 'Media reprint',
          content: 'The company reported revenue of 1 billion according to unnamed sources.',
          fetchStatus: 'ok',
        }],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'required_host_unread' || failure.code === 'required_primary_missing'));
  });

  it('ignores an LLM pass when deterministic checks fail', () => {
    const gate = evaluateReadinessGate({
      query: 'What is Ollama?',
      gaps: [{ id: 'gap-1', question: 'What is Ollama?', status: 'open', priority: 'critical', minIndependentSources: 1 }],
      findings: [],
      llmPass: true,
    });
    assert.equal(gate.pass, false);
    assert.equal(gate.deterministicPass, false);
    assert.ok(gate.flags.includes('llm_override_ignored'));
  });

  it('does not treat same-domain reprints as two independent sources', () => {
    const gate = evaluateReadinessGate({
      query: 'open topic space',
      gaps: [{
        id: 'gap-1',
        question: 'open topic space',
        status: 'body_read',
        priority: 'critical',
        minIndependentSources: 2,
      }],
      findings: [{
        gapId: 'gap-1',
        sources: [
          { url: 'https://news.example.com/one', content: 'First reprint of the same story with enough text.', fetchStatus: 'ok' },
          { url: 'https://blog.example.com/two', content: 'Second reprint of the same story with enough text.', fetchStatus: 'ok' },
        ],
      }],
    });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => failure.code === 'independent_sources_short'));
  });
});
