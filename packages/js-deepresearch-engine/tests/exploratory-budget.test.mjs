import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetManager } from '../src/research/budget-manager.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';
import { evaluateExploratorySufficiency, classifyResearchQuery, similarQuestions } from '../src/research/adaptive/exploratory-sufficiency.mjs';
import { buildBudgetView, estimateReportPromptTokens } from '../src/research/adaptive/budget-view.mjs';
import { mapStructuredProgressEvent } from '../src/research/progress-events.mjs';

describe('exploratory budget snapshot and sufficiency', () => {
  it('includes remaining tokens and report reserve when maxLlmTokens is finite', () => {
    const budget = new BudgetManager({
      research: {
        budget: { maxLlmTokens: 8000, reserveReportTokens: 1200 },
        exploratory: { targetLlmTokens: 6000 },
      },
    });
    budget.usage.llmTokens = 2000;
    const state = new ResearchState({ query: 'What is Ollama?', maxSteps: 8, targetLlmTokens: 6000, budget });
    state.findings.push({
      gapId: 'gap-1',
      question: 'What is Ollama?',
      sources: [{ title: 'Docs', url: 'https://ollama.com', summary: 'Ollama runs local models', fetchStatus: 'ok' }],
    });
    const view = state.refreshBudgetView({ budget, targetLlmTokens: 6000 });
    const snapshot = state.snapshot();

    assert.equal(snapshot.budget.usedLlmTokens, 2000);
    assert.equal(snapshot.budget.hardCapLlmTokens, 8000);
    assert.equal(snapshot.budget.targetLlmTokens, 6000);
    assert.equal(snapshot.budget.remainingVsHardCap, 6000);
    assert.equal(snapshot.budget.remainingVsTarget, 4000);
    assert.ok(snapshot.budget.reservedReportTokens > 0);
    assert.ok(snapshot.budget.reservedReportOutputTokens <= 1200);
    assert.ok(snapshot.budget.actionCostEstimates.read.estimatedTokens > 0);
    assert.equal(snapshot.sufficiency.sufficient, true);
    assert.ok(view.reservedReportTokens >= view.reservedReportOutputTokens);
    assert.ok(estimateReportPromptTokens({ query: state.query, findings: state.findings }) > 0);
  });

  it('marks comparison queries insufficient until each subject has body evidence', () => {
    const query = 'Compare Ollama and llama.cpp';
    assert.equal(classifyResearchQuery(query).kind, 'comparison');
    const oneSubject = evaluateExploratorySufficiency({
      query,
      findings: [{
        gapId: 'gap-1',
        sources: [{ title: 'Ollama', url: 'https://ollama.com', summary: 'Ollama wraps local models', fetchStatus: 'ok' }],
      }],
      gaps: [{ id: 'gap-1', question: query, status: 'open', priority: 'critical' }],
    });
    assert.equal(oneSubject.sufficient, false);
    assert.ok(oneSubject.missingSubjects.some((subject) => /llama\.cpp/i.test(subject)));
    assert.ok(oneSubject.flags.includes('comparison_coverage_incomplete'));

    const bothSubjects = evaluateExploratorySufficiency({
      query,
      findings: [{
        gapId: 'gap-1',
        sources: [
          { title: 'Ollama', url: 'https://ollama.com', summary: 'Ollama wraps local models', fetchStatus: 'ok' },
          { title: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp', summary: 'llama.cpp is a C++ inference engine', fetchStatus: 'ok' },
        ],
      }],
      gaps: [{ id: 'gap-1', question: query, status: 'resolved', priority: 'critical' }],
    });
    assert.equal(bothSubjects.sufficient, true);
    assert.deepEqual(bothSubjects.missingSubjects, []);
  });

  it('treats a simple definitional query with body evidence as sufficient', () => {
    const result = evaluateExploratorySufficiency({
      query: 'What is Ollama?',
      findings: [{
        gapId: 'gap-1',
        sources: [{ title: 'Ollama', url: 'https://ollama.com', content: 'Ollama runs local LLMs.', fetchStatus: 'ok' }],
      }],
      gaps: [{ id: 'gap-1', question: 'What is Ollama?', status: 'open', priority: 'critical' }],
    });
    assert.equal(result.queryKind, 'definitional');
    assert.equal(result.sufficient, true);
  });

  it('allows consecutive reads of different unread sources and rejects the same sources', () => {
    const state = new ResearchState({ query: 'open topic space', maxSteps: 8 });
    state.addCandidates([
      { url: 'https://open-a.test', title: 'A' },
      { url: 'https://open-b.test', title: 'B' },
    ], 'gap-1');
    state.readSourceIds.add('https://open-a.test');
    state.lastAction = 'read';
    assert.equal(state.validate({ action: 'read', sourceIds: ['https://open-b.test'] }), null);
    assert.equal(state.validate({ action: 'read', sourceIds: ['https://open-a.test'] }), 'repeat_action');
  });

  it('rejects paraphrased reflect gaps and does not use reflect as the default fallback', () => {
    const state = new ResearchState({ query: 'open topic space', maxSteps: 8 });
    state.addCandidates([{ url: 'https://open-a.test', title: 'A' }], 'gap-1');
    state.readSourceIds.add('https://open-a.test');
    state.lastAction = 'read';
    assert.equal(state.validate({ action: 'reflect', gapQuestion: 'What is an open topic space?' }), 'repeat_gap');
    assert.equal(state.validate({ action: 'reflect', gapQuestion: 'What deployment constraint is orthogonal?' }), null);
    assert.ok(similarQuestions('open topic space', 'What is an open topic space?'));
    const fallback = fallbackAdaptiveAction(state);
    assert.notEqual(fallback.action, 'reflect');
    assert.equal(fallback.action, 'answer');
  });

  it('keeps a dynamic report reserve inside the hard cap', () => {
    const budget = new BudgetManager({
      research: { budget: { maxLlmTokens: 3000, reserveReportTokens: 900 } },
    });
    budget.usage.llmTokens = 1500;
    const reserved = budget.updateReportReserve(700);
    assert.ok(reserved >= 900);
    assert.ok(reserved <= 1500);
    assert.equal(budget.canClaim('llmTokens', 2000), false);
    assert.equal(budget.canClaim('llmTokens', 100, { report: true }), true);
    const view = buildBudgetView({ budget, targetLlmTokens: 0 });
    assert.ok(view.reservedReportTokens > 0);
    assert.equal(view.hardCapLlmTokens, 3000);
  });

  it('maps exploratory enrich progress with step language instead of undefined iterations', () => {
    const mapped = mapStructuredProgressEvent({
      stage: 'enriching_sources',
      step: 2,
      maxSteps: 6,
      total: 2,
    });
    assert.equal(mapped.message, 'Enriching sources for step 2/6');
    assert.ok(!/undefined/.test(mapped.message));

    const missingLoop = mapStructuredProgressEvent({
      stage: 'enriching_sources',
      total: 2,
    });
    assert.equal(missingLoop.message, 'Enriching sources');
    assert.ok(!/undefined\/undefined/.test(missingLoop.message));
  });

  it('persists covered gap status so snapshots stay truthful', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 6 });
    state.addGap('sub-question two');
    state.findings.push({ gapId: 'gap-2', sources: [{ url: 'https://x.test', fetchStatus: 'ok' }] });
    state.syncGapCoverage();
    assert.equal(state.gaps.find((gap) => gap.id === 'gap-2').status, 'resolved');
    assert.equal(state.gaps.find((gap) => gap.id === 'gap-1').status, 'open');
    const snapshot = state.snapshot();
    assert.equal(snapshot.gaps.find((gap) => gap.id === 'gap-2').covered, true);
    assert.deepEqual(snapshot.bodyEvidenceCoverage.resolvedGaps, ['gap-2']);
  });
});
