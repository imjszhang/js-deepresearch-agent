import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BudgetManager,
  ResearchRunner,
  assembleReport,
  looksTruncated,
  reviseUnsupportedKeyClaims,
  validateReportOutput,
} from '../src/index.mjs';

const findings = [{
  question: 'What is Ollama?',
  sources: [{
    title: 'Ollama docs',
    url: 'https://ollama.com',
    summary: 'Ollama runs local models.',
    content: 'Ollama runs local models on Apple Silicon.',
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
  }],
}];

describe('report completeness and assembly', () => {
  it('rejects a mid-sentence truncation', () => {
    const truncated = `# Research Report

## Summary
llama.cpp 支持 1.`;
    assert.equal(looksTruncated(truncated), true);
    const check = validateReportOutput(truncated, { minChars: 20, mode: 'narrative' });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_truncated'));
  });

  it('assembles Evidence, Caveats, and Sources from findings', () => {
    const report = assembleReport({
      narrative: `# Research Report

## Summary
Ollama is a local model runner. [1.1]

## Key Findings
Ollama targets easy local inference. [1.1]
`,
      findings,
      limitations: ['Snippet-only sources cannot verify body facts.'],
      query: 'What is Ollama?',
    });
    assert.match(report, /## Summary/);
    assert.match(report, /## Evidence/);
    assert.match(report, /## Caveats/);
    assert.match(report, /## Sources/);
    assert.match(report, /https:\/\/ollama.com/);
    assert.match(report, /\[1\.1\]/);
    const check = validateReportOutput(report, { minChars: 80, mode: 'full', findings });
    assert.equal(check.ok, true, check.flags.join(','));
  });

  it('moves unsupported key claims into Caveats instead of prefixing Unverified', () => {
    const narrative = `# Research Report

## Summary
This key sentence has no backing evidence at all.
`;
    const assembled = assembleReport({ narrative, findings, query: 'topic' });
    const revised = reviseUnsupportedKeyClaims(assembled, [{
      kind: 'key_claim',
      text: 'This key sentence has no backing evidence at all.',
      evaluation: { verdict: 'unverifiable' },
    }]);
    assert.ok(!revised.report.includes('Unverified:'));
    assert.match(revised.report, /## Caveats/);
    assert.match(revised.report, /This key sentence has no backing evidence at all/);
    assert.equal(revised.moved.length, 1);
  });

  it('writes a report after the exploration cap is exhausted', async () => {
    const result = await new ResearchRunner().run({
      query: 'budget topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 4, maxEvaluationRetries: 0, autoReadTopK: 0 },
          focused: { fetchMode: 'disabled' },
          budget: { maxLlmTokens: 2500, maxSearchRequests: 4, maxSourceReads: 0 },
        },
      },
      search: { async search() {
        return [{ title: 'Cap', url: 'https://budget.test', content: 'Budget topic evidence.', fetchStatus: 'ok' }];
      } },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'agent_decision') return JSON.stringify({ action: 'search', query: 'budget topic', gapId: 'gap-1' });
          if (purpose === 'gap_decomposition') return 'no json';
          return `# Research Report

## Summary
The selected source covers the budget topic with enough detail to write a complete narrative after exploration stops. [1.1]

## Key Findings
Budget topic evidence remains available after the exploration token cap is reached, so the final report can still be assembled. [1.1]
`;
        },
      },
    });
    assert.ok(result.report.length > 400);
    assert.match(result.report, /## Evidence/);
    assert.match(result.report, /## Sources/);
    assert.ok((result.quality.budget.usage.reportTokens || 0) >= 0);
    assert.ok((result.quality.budget.usage.llmTokens || 0) >= (result.quality.budget.usage.explorationTokens || 0));
  });
});

describe('report token budgeting', () => {
  it('omits report usage from the exploration hard-cap check', () => {
    const budget = new BudgetManager({ research: { budget: { maxLlmTokens: 1000 } } });
    budget.claim('llmTokens', 1000, { purpose: 'agent_decision' });
    assert.equal(budget.canClaim('llmTokens', 1), false);
    assert.equal(budget.canClaim('llmTokens', 2000, { purpose: 'report', report: true }), true);
  });
});
