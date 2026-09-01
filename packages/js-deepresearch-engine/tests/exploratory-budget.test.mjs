import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetManager } from '../src/research/budget-manager.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { fallbackAdaptiveAction } from '../src/research/adaptive/agent-policy.mjs';
import { evaluateExploratorySufficiency, classifyResearchQuery, similarQuestions } from '../src/research/adaptive/exploratory-sufficiency.mjs';
import { buildBudgetView, estimateReportPromptTokens } from '../src/research/adaptive/budget-view.mjs';
import { applyExploratoryBudget, effectiveExploratoryMaxSteps, EXPLORATORY_SAFETY_MAX_STEPS, resolveExploratorySettings } from '../src/research/exploratory-settings.mjs';
import { mapStructuredProgressEvent } from '../src/research/progress-events.mjs';

describe('exploratory budget snapshot and sufficiency', () => {
  it('includes remaining tokens and report reserve when maxLlmTokens is finite', () => {
    const budget = new BudgetManager({
      research: {
        budget: { maxLlmTokens: 8000, reserveReportTokens: 1200 },
        exploratory: { minLlmTokens: 6000, maxLlmTokens: 8000 },
      },
    });
    budget.usage.llmTokens = 2000;
    const state = new ResearchState({ query: 'What is Ollama?', maxSteps: 8, minLlmTokens: 6000, budget });
    state.findings.push({
      gapId: 'gap-1',
      question: 'What is Ollama?',
      sources: [{ title: 'Docs', url: 'https://ollama.com', summary: 'Ollama runs local models', fetchStatus: 'ok' }],
    });
    const view = state.refreshBudgetView({ budget, minLlmTokens: 6000 });
    const snapshot = state.snapshot();

    assert.equal(snapshot.budget.usedLlmTokens, 2000);
    assert.equal(snapshot.budget.hardCapLlmTokens, 8000);
    assert.equal(snapshot.budget.minLlmTokens, 6000);
    assert.equal(snapshot.budget.targetLlmTokens, 6000);
    assert.equal(snapshot.budget.remainingVsHardCap, 6000);
    assert.equal(snapshot.budget.remainingVsMin, 4000);
    assert.equal(snapshot.budget.remainingVsTarget, 4000);
    assert.equal(snapshot.budget.belowMin, true);
    assert.equal(snapshot.budget.minReached, false);
    assert.equal(snapshot.budget.reservedReportTokens, 0);
    assert.equal(snapshot.budget.hardCapReached, false);
    assert.ok(snapshot.budget.actionCostEstimates.read.estimatedTokens > 0);
    assert.equal(snapshot.sufficiency.sufficient, false);
    assert.equal(view.reservedReportTokens, 0);
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
    state.observations.push({ type: 'search_result', query: 'open topic space', resultCount: 1 });
    state.lastAction = 'read';
    assert.equal(state.validate({ action: 'reflect', gapQuestion: 'What is an open topic space?' }), 'repeat_gap');
    assert.equal(state.validate({ action: 'reflect', gapQuestion: 'What deployment constraint is orthogonal?' }), null);
    assert.ok(similarQuestions('open topic space', 'What is an open topic space?'));
    const fallback = fallbackAdaptiveAction(state, { belowHardCap: true, readiness: { pass: false } });
    assert.notEqual(fallback.action, 'reflect');
    assert.equal(fallback.action, 'search');
  });

  it('defaults exploratory count caps to unlimited and does not inherit global budget counts', () => {
    const resolved = resolveExploratorySettings({
      research: { budget: { maxSearchRequests: 18, maxSourceReads: 16 } },
    });
    assert.equal(resolved.maxSearchRequests, 0);
    assert.equal(resolved.maxSourceReads, 0);
    assert.equal(resolved.maxSteps, 0);
    assert.equal(resolved.minLlmTokens, 600000);
    assert.equal(resolved.maxLlmTokens, 1000000);
  });

  it('keeps maxSteps unlimited when a token ceiling is set and uses a safety valve only when both are off', () => {
    assert.equal(effectiveExploratoryMaxSteps({ maxSteps: 0, maxLlmTokens: 80000 }), 0);
    assert.equal(effectiveExploratoryMaxSteps({ maxSteps: 12, maxLlmTokens: 80000 }), 12);
    assert.equal(effectiveExploratoryMaxSteps({ maxSteps: 0, maxLlmTokens: 0 }), EXPLORATORY_SAFETY_MAX_STEPS);
    assert.equal(effectiveExploratoryMaxSteps({ maxSteps: 0, maxLlmTokens: 0 }, 3000), 0);
    const unlimitedState = new ResearchState({ query: 'topic', maxSteps: 0 });
    unlimitedState.step = 20;
    assert.equal(unlimitedState.validate({ action: 'search', query: 'next' }), null);
    assert.equal(unlimitedState.snapshot().stepsRemaining, null);
    const defaultState = new ResearchState({ query: 'topic' });
    assert.equal(defaultState.maxSteps, 0);
    assert.equal(defaultState.snapshot().stepsRemaining, null);
  });

  it('overrides global search and read count limits with exploratory values', () => {
    const unlimited = new BudgetManager({
      research: { budget: { maxSearchRequests: 18, maxSourceReads: 16, maxLlmTokens: 80000 } },
    });
    applyExploratoryBudget(unlimited, {
      minLlmTokens: 20000,
      maxLlmTokens: 80000,
      maxSearchRequests: 0,
      maxSourceReads: 0,
    });
    assert.equal(unlimited.limits.searchRequests, 0);
    assert.equal(unlimited.limits.sourceReads, 0);
    assert.equal(unlimited.canClaim('sourceReads', 20), true);

    const explicit = new BudgetManager({
      research: { budget: { maxSearchRequests: 10, maxSourceReads: 8 } },
    });
    applyExploratoryBudget(explicit, {
      minLlmTokens: 0,
      maxLlmTokens: 0,
      maxSearchRequests: 20,
      maxSourceReads: 30,
    });
    assert.equal(explicit.limits.searchRequests, 20);
    assert.equal(explicit.limits.sourceReads, 30);
  });

  it('treats the token floor as a keep-exploring bound instead of a stop target', () => {
    const resolved = resolveExploratorySettings({
      research: { exploratory: { minLlmTokens: 20000, maxLlmTokens: 80000 } },
    });
    assert.equal(resolved.minLlmTokens, 20000);
    assert.equal(resolved.maxLlmTokens, 80000);
    assert.equal(resolved.targetLlmTokens, 20000);

    const view = buildBudgetView({
      budget: { usage: { llmTokens: 4000 }, limits: { llmTokens: 80000 }, reservedReportTotalTokens: 1600 },
      minLlmTokens: 20000,
    });
    assert.equal(view.belowMin, true);
    assert.equal(view.minReached, false);
    assert.equal(view.remainingVsMin, 16000);
    assert.equal(view.nearTarget, false);

    const state = new ResearchState({ query: 'What is Ollama?', maxSteps: 8, minLlmTokens: 20000 });
    state.addCandidates([
      { url: 'https://ollama.com', title: 'Docs' },
      { url: 'https://github.com/ollama/ollama', title: 'Repo' },
    ], 'gap-1');
    state.readSourceIds.add('https://ollama.com');
    state.findings.push({
      gapId: 'gap-1',
      sources: [{ url: 'https://ollama.com', content: 'Ollama runs local models.', fetchStatus: 'ok' }],
    });
    state.sufficiency = evaluateExploratorySufficiency({
      query: state.query,
      findings: state.findings,
      gaps: state.gaps,
      state,
    });
    const keepGoing = fallbackAdaptiveAction(state, { belowMin: true, sufficiency: state.sufficiency });
    assert.equal(keepGoing.action, 'read');
    assert.deepEqual(keepGoing.sourceIds, ['https://github.com/ollama/ollama']);
  });

  it('lets exploration use the full token ceiling and still claim a report', () => {
    const budget = new BudgetManager({
      research: { budget: { maxLlmTokens: 3000, reserveReportTokens: 900 } },
    });
    budget.usage.llmTokens = 1500;
    assert.equal(budget.updateReportReserve(700), 0);
    assert.equal(budget.canClaim('llmTokens', 2000), false);
    assert.equal(budget.canClaim('llmTokens', 1400), true);
    assert.equal(budget.canClaim('llmTokens', 100, { report: true }), true);
    const view = buildBudgetView({ budget, targetLlmTokens: 0 });
    assert.equal(view.reservedReportTokens, 0);
    assert.equal(view.hardCapReached, false);
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

    const unlimitedSteps = mapStructuredProgressEvent({
      stage: 'enriching_sources',
      step: 20,
      maxSteps: 0,
      total: 2,
    });
    assert.equal(unlimitedSteps.message, 'Enriching sources');
    assert.ok(!/20\/0/.test(unlimitedSteps.message));
  });

  it('persists covered gap status so snapshots stay truthful', () => {
    const state = new ResearchState({ query: 'topic', maxSteps: 6 });
    state.addGap('sub-question two');
    state.findings.push({
      gapId: 'gap-2',
      sources: [{ url: 'https://x.test', fetchStatus: 'ok', content: 'Sub-question two now has a successful body with enough detail.' }],
    });
    state.syncGapCoverage();
    assert.equal(state.gaps.find((gap) => gap.id === 'gap-2').status, 'verified');
    assert.equal(state.gaps.find((gap) => gap.id === 'gap-1').status, 'open');
    const snapshot = state.snapshot();
    assert.equal(snapshot.gaps.find((gap) => gap.id === 'gap-2').covered, true);
    assert.deepEqual(snapshot.bodyEvidenceCoverage.resolvedGaps, ['gap-2']);
  });
});
