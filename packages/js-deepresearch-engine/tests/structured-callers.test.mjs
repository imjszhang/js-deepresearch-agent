import assert from 'node:assert/strict';
import { ResearchRunner as LegacyResearchRunner } from './helpers/legacy-research-runner.mjs';
import { describe, it } from 'node:test';
import { BudgetManager, wrapProvidersWithBudget } from '../src/research/budget-manager.mjs';
import { completeStructuredJson } from '../src/research/structured-llm.mjs';
import { parseNarrativeResponse } from '../src/research/report-narrative.mjs';
import { buildReport } from '../src/research/report-builder.mjs';
import { filterFindingsByRelevance } from '../src/research/source-relevance-filter.mjs';
import { applyClaimEntailment, entailmentCacheKey } from '../src/research/claim-entailment.mjs';
import { decideAdaptiveAction, decomposeQuery, evaluateAnswerReadiness } from '../src/research/adaptive/agent-policy.mjs';
import { assessSourceBody } from '../src/research/source-assessment.mjs';
import { planResearchProfile } from '../src/research/adaptive/research-profile.mjs';

const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
function responseModel(outputs, finishReasons = []) {
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      return outputs[Math.min(calls.length - 1, outputs.length - 1)];
    },
    getLastCallMetadata() { return { finishReason: finishReasons[calls.length - 1] || 'stop' }; },
  };
}
const narrative = {
  title: 'Evidence backed findings',
  summary: ['The documentation describes a reproducible mechanism whose assumptions must remain visible in the final report. [1.1]'],
  keyFindings: [{ heading: 'Mechanism', claims: ['The documented mechanism depends on the stated operating assumptions and the result remains conditional on them. [1.1]'] }],
  caveats: ['Deployments need to verify the same conditions before relying on this result.'],
};
const findings = [{ question: 'Mechanism', sources: [{ url: 'https://example.test/doc', title: 'Documentation', content: 'The documented mechanism depends on the stated operating assumptions.', fetchStatus: 'ok', contentOrigin: 'fetched' }] }];
const baseMessages = [{ role: 'user', content: 'Return the requested structure.' }];
const state = {
  query: 'Mechanism', readiness: { pass: false }, gaps: [], knowledge: '', findings: [],
  snapshotForAgent() { return { readiness: this.readiness, budget: {} }; },
};

describe('shared structured caller boundary', () => {
  it('accepts prose and repeated complete answers in one provider call', async () => {
    const value = { gaps: ['mechanism'] };
    const llm = responseModel([`Explanation with {placeholder}.\n${fence(value)}\nRepeated answer:\n${fence(value)}`]);
    const result = await completeStructuredJson({ llm, messages: baseMessages });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(result.parsed, value);
  });

  it('retries ambiguity with safe feedback and never returns a selected conflicting candidate', async () => {
    const raw = `${fence({ gaps: ['first'] })}\n${fence({ gaps: ['second'] })}\nPRIVATE PROVIDER PROSE`;
    const llm = responseModel([raw]);
    const result = await completeStructuredJson({ llm, messages: baseMessages });
    assert.equal(result.ok, false);
    assert.equal(result.parseReason, 'ambiguous_result');
    assert.equal(result.parsed, null);
    assert.equal(llm.calls.length, 2);
    assert.notDeepEqual(llm.calls[0].messages, llm.calls[1].messages);
    assert.match(JSON.stringify(llm.calls[1].messages), /ambiguous_result/);
    assert.doesNotMatch(JSON.stringify(llm.calls[1].messages), /PRIVATE PROVIDER PROSE|first|second/);
    assert.deepEqual(baseMessages, [{ role: 'user', content: 'Return the requested structure.' }]);
  });

  it('rejects complete JSON with a length finish reason and accepts a separately completed retry', async () => {
    const llm = responseModel([JSON.stringify({ gaps: ['mechanism'] })], ['length', 'stop']);
    const result = await completeStructuredJson({ llm, messages: baseMessages });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.reason, 'finish_reason_length');
    assert.equal(result.parseReason, 'truncated');
  });

  it('does not salvage an earlier schema failure after an ambiguous final retry', async () => {
    const llm = responseModel(['{"gaps":[]}', `${fence({ gaps: ['first'] })}\n${fence({ gaps: ['second'] })}`]);
    const result = await completeStructuredJson({ llm, messages: baseMessages });
    assert.equal(result.ok, false);
    assert.equal(result.parsed, null);
  });

  it('passes transport failures through without structure retries', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('provider failed'), { code: 'ECONNRESET' });
    await assert.rejects(completeStructuredJson({
      messages: baseMessages,
      llm: { async complete() { calls++; throw failure; } },
    }), (error) => error === failure);
    assert.equal(calls, 1);
  });
});

describe('narrative caller parsing', () => {
  it('deduplicates before display cleaning and keeps single invalid schema diagnostics', () => {
    const parsed = parseNarrativeResponse(`${fence(narrative)}\n${fence(narrative)}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.narrative.title, narrative.title);
    const invalid = parseNarrativeResponse(JSON.stringify({ ...narrative, evidence: [] }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.parseReason, 'schema_invalid');
    assert.ok(invalid.flags.includes('narrative_has_generated_sections'));
  });

  it('rejects differences that display cleanup would otherwise erase', () => {
    const different = { ...narrative, title: `${narrative.title} [gap-1]` };
    const parsed = parseNarrativeResponse(`${fence(narrative)}\n${fence(different)}`);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.parseReason, 'ambiguous_result');
    assert.equal(parsed.narrative, null);
  });

  it('builds a report from wrapped JSON without a second model call', async () => {
    const llm = responseModel([`An explanation uses {placeholder}.\n${fence(narrative)}\n${fence(narrative)}`]);
    const report = await buildReport({ llm, query: 'Mechanism', findings });
    assert.equal(llm.calls.length, 1);
    assert.equal(report.origin, 'json');
    assert.match(report.text, /Evidence backed findings/);
    assert.doesNotMatch(report.text, /placeholder/);
  });

  it('ignores structured examples in an explicit reasoning prefix before a Markdown answer', async () => {
    const markdown = `# Evidence backed findings\n\n## Summary\n${narrative.summary[0]}\n\n## Key Findings\n- ${narrative.keyFindings[0].claims[0]}`;
    const llm = responseModel([`<think>${fence(narrative)}</think>\n${markdown}`]);
    const result = await buildReport({ llm, query: 'Mechanism', findings });
    assert.equal(result.origin, 'markdown');
    assert.equal(llm.calls.length, 1);
    assert.doesNotMatch(result.text, /think|```/);
  });

  it('[V24] Markdown fallback cannot bypass ambiguous JSON with escaped field names', async () => {
    const markdown = `# Evidence backed findings\n\n## Summary\n${narrative.summary[0]}\n\n## Key Findings\n- ${narrative.keyFindings[0].claims[0]}`;
    const escaped = value => JSON.stringify(value).replaceAll('"title"', '"\\u0074itle"');
    const response = `${markdown}\n${escaped(narrative)}\n${escaped({ ...narrative, title: 'Different answer' })}`;
    const llm = responseModel([response]);
    await assert.rejects(buildReport({ llm, query: 'Mechanism', findings }), error => error.phase === 'parse');
    assert.equal(llm.calls.length, 2);
    assert.match(JSON.stringify(llm.calls[1].messages), /ambiguous_result/);
  });

  it('[V24] Markdown fallback cannot bypass malformed or incomplete JSON candidates', async () => {
    const markdown = `# Evidence backed findings\n\n## Summary\n${narrative.summary[0]}\n\n## Key Findings\n- ${narrative.keyFindings[0].claims[0]}`;
    for (const candidate of ['{"\\u0074itle":1,"broken":}', '{"\\u0074itle":"unfinished"']) {
      const llm = responseModel([`${markdown}\n${candidate}`]);
      await assert.rejects(buildReport({ llm, query: 'Mechanism', findings }), error => error.phase === 'parse');
      assert.equal(llm.calls.length, 2);
    }
  });

  it('does not let report-wide cleaning merge conflicting JSON answers', async () => {
    const llm = responseModel([`${fence(narrative)}\n${fence({ ...narrative, title: `${narrative.title} [gap-1]` })}`]);
    await assert.rejects(buildReport({ llm, query: 'Mechanism', findings }), (error) => error.phase === 'parse');
    assert.equal(llm.calls.length, 2);
    assert.match(JSON.stringify(llm.calls[1].messages), /ambiguous_result/);
  });
});

describe('legacy action and array callers', () => {
  it('selects one full action and normalizes aliases only after ambiguity checks', async () => {
    const decision = await decideAdaptiveAction({ llm: responseModel([fence({ action: 'answer' })]), state });
    assert.equal(decision.action, 'finalize');
    const ambiguous = await decideAdaptiveAction({ llm: responseModel([`${fence({ action: 'answer' })}\n${fence({ action: 'finalize' })}`]), state });
    assert.equal(ambiguous, null);
  });

  it('parses decomposition and preserves the deterministic readiness gate', async () => {
    const parts = { subQuestions: ['Mechanism?', 'Conditions?'] };
    assert.deepEqual(await decomposeQuery({ state, llm: responseModel([`${fence(parts)}\n${fence(parts)}`]) }), parts.subQuestions);
    const readiness = await evaluateAnswerReadiness({ state, llm: responseModel([fence({ pass: true, missingAspect: '' })]) });
    assert.equal(readiness.llmPass, true);
    assert.equal(readiness.pass, false);
  });

  it('filters repeated decision arrays without greedily merging them', async () => {
    const decisions = [{ index: 1, keep: false, score: 0, reason: 'unrelated' }];
    const llm = responseModel([`${fence(decisions)}\n${fence(decisions)}`]);
    const result = await filterFindingsByRelevance(findings, { query: 'Mechanism', enabled: true, llm });
    assert.deepEqual(result, []);
    assert.equal(llm.calls.length, 1);
  });

  it('retains fallback sources on conflicting or truncated decision arrays', async () => {
    const drop = [{ index: 1, keep: false, score: 0, reason: 'unrelated' }];
    for (const llm of [responseModel([`${fence(drop)}\n${fence([{ index: 1, keep: true }])}`]), responseModel([fence(drop)], ['length'])]) {
      const result = await filterFindingsByRelevance(findings, { query: 'Mechanism', enabled: true, llm });
      assert.equal(result[0].sources.length, 1);
      assert.equal(result[0].sources[0].relevanceScore, 0.5);
    }
  });
});

describe('entailment parsing and control flow', () => {
  const passage = { id: 'p-1', sourceId: 's-1', text: 'The mechanism depends on the documented operating assumptions.' };
  const claim = { kind: 'key_claim', text: 'The mechanism has conditions.', citationKeys: ['1.1'], citedSourceIds: ['s-1'], flags: [], evaluation: { verdict: 'unverifiable' } };
  const judgment = { verdict: 'supported', quote: passage.text };
  it('accepts repeated anchored judgments and caches under the parser version', async () => {
    const llm = responseModel([`${fence(judgment)}\n${fence(judgment)}`]);
    const cache = new Map();
    const result = await applyClaimEntailment([claim], { llm, passages: [passage], cache });
    assert.equal(result[0].evaluation.verdict, 'supported');
    assert.equal(cache.has(entailmentCacheKey(claim, [passage])), true);
    await applyClaimEntailment([claim], { llm, passages: [passage], cache });
    assert.equal(llm.calls.length, 1);
  });

  it('never caches or applies a conflicting or truncated entailment result', async () => {
    for (const llm of [responseModel([`${fence(judgment)}\n${fence({ ...judgment, verdict: 'unsupported' })}`]), responseModel([fence(judgment)], ['length'])]) {
      const cache = new Map();
      const result = await applyClaimEntailment([claim], { llm, passages: [passage], cache });
      assert.equal(result[0], claim);
      assert.equal(cache.size, 0);
    }
  });

  for (const failure of [
    Object.assign(new Error('budget'), { name: 'BudgetExceededError' }),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    Object.assign(new Error('integrity'), { code: 'EVIDENCE_INTEGRITY' }),
  ]) {
    it(`propagates ${failure.name === 'Error' ? failure.code : failure.name} through secondary callers`, async () => {
      const llm = { async complete() { throw failure; } };
      const calls = [
        () => decomposeQuery({ llm, state }),
        () => evaluateAnswerReadiness({ llm, state }),
        () => applyClaimEntailment([claim], { llm, passages: [passage] }),
        () => assessSourceBody({ llm }),
        () => planResearchProfile({ llm, query: 'Mechanism' }),
      ];
      for (const call of calls) await assert.rejects(call(), (error) => error === failure);
    });
  }
});


describe('unknown usage at secondary structured boundaries', () => {
  it('[V24] invalid wrapped responses stop before retry or fallback while preserving reservations', async () => {
    const passage = { id: 'p-1', sourceId: 's-1', text: 'The mechanism depends on the documented operating assumptions.' };
    const claim = { kind: 'key_claim', text: 'Conditional mechanism.', citationKeys: ['1.1'], citedSourceIds: ['s-1'], evaluation: { verdict: 'unverifiable' } };
    const calls = [
      llm => completeStructuredJson({ llm, messages: baseMessages }),
      llm => decideAdaptiveAction({ llm, state }),
      llm => decomposeQuery({ llm, state }),
      llm => evaluateAnswerReadiness({ llm, state }),
      llm => applyClaimEntailment([claim], { llm, passages: [passage] }),
      llm => filterFindingsByRelevance(findings, { llm, query: 'Mechanism', enabled: true }),
      llm => assessSourceBody({ llm }),
      llm => planResearchProfile({ llm, query: 'Mechanism' }),
      llm => buildReport({ llm, query: 'Mechanism', findings }),
    ];
    for (const call of calls) {
      const budget = new BudgetManager({ research: { strategy: 'exploratory', exploratory: { minLlmTokens: 0, maxLlmTokens: 100000 } } });
      budget.executionVersion = 2;
      let requests = 0;
      const { llm } = wrapProvidersWithBudget({ budget, search: {}, llm: { async completeWithMetadata() {
        requests++;
        return { text: '```json\n{invalid}\n```', finishReason: 'stop' };
      } } });
      await assert.rejects(call(llm), { code: 'LLM_USAGE_UNKNOWN' });
      assert.equal(requests, 1);
      assert.equal(budget.reservations.size, 1);
      assert.equal(budget.unknown.llmTokens, true);
    }
  });
});


it('[V24] legacy exploration cannot convert a planner usage interruption into a fallback action', async () => {
  const failure = Object.assign(new Error('unknown call'), { code: 'LLM_USAGE_UNKNOWN' });
  let plannerCalls = 0;
  await assert.rejects(new LegacyResearchRunner().run({
    query: 'Mechanism',
    settings: { llm: {}, search: {}, research: { strategy: 'exploratory',
      exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 1, autoReadTopK: 0 },
      focused: { fetchMode: 'disabled' } } },
    search: { async search() { assert.fail('Planner interruption must prevent search'); } },
    llm: { async complete({ purpose }) {
      if (purpose === 'research_profile') return JSON.stringify({ requiredAnswerSlots: [{ answerSlot: 'mechanism', question: 'Mechanism evidence' }] });
      if (purpose === 'gap_decomposition') return '{"subQuestions":[]}';
      if (purpose === 'agent_decision') return '{"action":"search","gapId":"gap-1"}';
      if (purpose === 'search_query_planning') { plannerCalls++; throw failure; }
      assert.fail(`Unexpected call after interruption: ${purpose}`);
    } },
  }), actual => actual === failure);
  assert.equal(plannerCalls, 1);
});
