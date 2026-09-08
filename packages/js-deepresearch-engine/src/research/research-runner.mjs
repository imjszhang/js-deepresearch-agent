import { migrateUnfinishedLegacyState } from './legacy-state-migration.mjs';
import { continueAfterStrategy } from './report-preparation.mjs';
import { finalizePreparedReport } from './report-finalizer.mjs';
import { createLlmProvider } from '../llm/provider-factory.mjs';
import { createSearchEngine } from '../search/search-factory.mjs';
import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { createProgressEmitter } from './progress-events.mjs';

import { resolveReportSettings } from './report-settings.mjs';
import { runStrategy } from './strategies.mjs';
import { BudgetManager, BudgetExceededError, wrapProvidersWithBudget } from './budget-manager.mjs';
import { QueryMemory } from './query-memory.mjs';
import { listSnippetOnlyCitationKeys } from "./evidence-chain.mjs";
import { evaluatePreReport } from './quality-gates.mjs';

import { closeHeadlessPool } from './headless-backend.mjs';
import { plannerFactsFromSnapshot } from './transport-memory.mjs';

import { buildResearchLimitations } from './limitations.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { createResearchProviders } from './research-providers.mjs';

import { researchBriefFromInput } from './research-brief.mjs';
import { createResearchRequest, EXECUTION_VERSION } from './research-request.mjs';

import { loadNamedCheckpoint, maxRecordedCallSequence, recorderOrNoop } from './run-recorder.mjs';
import { selectResearchResumePlan, finalResultFromCheckpoint } from './resume-plan.mjs';

import { runExploratoryLoop } from './strategies/exploratory-loop.mjs';
import { buildReportContract } from './report-contract.mjs';
import { buildReportPlan } from "./report-plan.mjs";

export class ResearchRunner {
  async run({
    query,
    planningContext,
    executionVersion = EXECUTION_VERSION,
    settings,
    signal,
    onProgress = () => {},
    llm: providedLlm,
    search: providedSearch,
    recorder: providedRecorder,
  }) {
    if (![1, EXECUTION_VERSION].includes(executionVersion)) throw new TypeError("Unsupported execution version");
    const request = createResearchRequest(query, { planningContext });
    const recorder = recorderOrNoop(providedRecorder);
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'focused';
    const queryWasStructured = typeof query === 'object' && query !== null;
    const brief = researchBriefFromInput(query, { depth: strategy });
    if (executionVersion === EXECUTION_VERSION) Object.assign(brief, { schemaVersion: 3, request, executionVersion, query: request.originalQuery });
    query = request.originalQuery;
    const emit = createProgressEmitter(onProgress);
    const trace = [];
    const appendTrace = Array.prototype.push.bind(trace);
    Object.defineProperty(trace, 'push', {
      enumerable: false,
      configurable: false,
      value: (...entries) => {
        for (const entry of entries) recorder.event('trace', entry);
        return appendTrace(...entries);
      },
    });
    trace.push({
      step: 1,
      action: 'research_brief',
      reasonCode: queryWasStructured ? 'structured_input' : 'query_compatibility_input',
      brief,
      createdAt: new Date().toISOString(),
    });
    recorder.event('research_brief', {
      strategy,
      query,
      brief,
      queryWasStructured,
    });
    const budget = new BudgetManager(settings, emit);
    budget.executionVersion = executionVersion;
    const { llm, search } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      recorder,
      onLlmEvent: (event) => {
        trace.push({
          step: trace.length + 1,
          action: 'llm_call',
          reasonCode: event.purpose,
          ...event,
          createdAt: new Date().toISOString(),
        });
        emit({ stage: event.status === 'started' ? 'llm_call_started' : 'llm_call_finished', ...event });
      },
    });
    const focused = resolveFocusedSettings(settings);
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      fetch: proxiedFetch,
      recorder,
      onEvent: (event) => {
        const action = event.operation === 'embed' ? 'embed' : 'rerank';
        trace.push({ step: trace.length + 1, action, reasonCode: `${event.operation}_${event.status}`, ...event, createdAt: new Date().toISOString() });
        const stage = event.operation === 'embed'
          ? (event.status === 'started' ? 'embed_started' : (event.status === 'degraded' ? 'embed_degraded' : 'embed_completed'))
          : (event.status === 'started' ? 'rerank_started' : (event.status === 'degraded' ? 'rerank_degraded' : 'rerank_completed'));
        emit({ stage, ...event });
      },
    });
    const queryMemory = new QueryMemory({
      ...focused.queryMemory,
      similarityProvider: researchProviders.similarity,
      onSkip: (event) => trace.push({ step: trace.length + 1, action: 'query_skipped_duplicate', ...event, createdAt: new Date().toISOString() }),
    });
    recorder.checkpoint('research-start', {
      strategy,
      query,
      brief,
      budget: budget.exportCheckpoint(),
      queryMemory: queryMemory.exportCheckpoint(),
      trace,
    });

    try {
    emit({ stage: 'research_started' });
    let findings;
    try {
      findings = await runStrategy({
        strategy,
        query,
        brief,
        settings,
        llm,
        search,
        signal,
        emit,
        budget,
        queryMemory,
        trace,
        researchProviders,
        recorder,
      });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      findings = [];
      trace.push({ step: trace.length + 1, action: 'research_stopped', reasonCode: 'budget_exhausted', kind: error.kind, createdAt: new Date().toISOString() });
    }

    return await continueAfterStrategy({
      findings,
      strategy,
      query,
      brief,
      settings,
      llm,
      signal,
      emit,
      recorder,
      budget,
      queryMemory,
      researchProviders,
      focused,
      trace,
    });
    } finally {
      await closeHeadlessPool().catch(() => {});
    }
  }

  async resumeFromSession({
    sessionDir,
    settings,
    signal,
    onProgress = () => {},
    llm: providedLlm,
    search: providedSearch,
    recorder: providedRecorder,
    continueExplore = false,
    extraSteps = 0,
    extraSearches = 0,
    extraReads = 0,
  }) {
    const plan = selectResearchResumePlan({
      sessionDir,
      continueExplore,
      extraSteps,
    });
    if (plan.mode === 'commit-result') {
      signal?.throwIfAborted();
      return finalResultFromCheckpoint(plan.checkpoint, sessionDir);
    }
    if (plan.mode === 'report-from-strategy') {
      return this.resumeReportFromStrategyComplete({
        sessionDir,
        settings,
        signal,
        onProgress,
        llm: providedLlm,
        search: providedSearch,
        recorder: providedRecorder,
        checkpoint: plan.checkpoint,
      });
    }
    if (plan.mode !== 'report') {
      return this.resumeExploreFromSession({
        sessionDir,
        settings,
        signal,
        onProgress,
        llm: providedLlm,
        search: providedSearch,
        recorder: providedRecorder,
        plan,
        extraSearches,
        extraReads,
      });
    }
    const pre = plan.checkpoint;
    const strategyComplete = loadNamedCheckpoint(sessionDir, 'strategy-complete');
    const passagesExtracted = loadNamedCheckpoint(sessionDir, 'passages-extracted');
    const state = pre.state;
    const strategy = state.strategy || settings?.research?.strategy || 'focused';
    const query = state.query;
    const resolvedBrief = state.brief;
    const findings = state.findings || [];
    const gaps = state.gaps || [];
    const control = strategyComplete?.state?.control || null;
    const exploratoryLoop = strategy === 'exploratory' ? control : null;
    const focusedControl = strategy === 'focused' ? control : null;
    const recorder = recorderOrNoop(providedRecorder);
    const emit = createProgressEmitter(onProgress);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || { async search() { return []; } };
    const budget = new BudgetManager(settings, emit);
    if (state.budget) budget.restoreCheckpoint(state.budget);
    const budgetBeforeReport = budget.snapshot();
    const focused = resolveFocusedSettings(settings);
    const reportSettings = resolveReportSettings(settings);
    const evidenceOptions = strategy === 'exploratory'
      ? { ...focused.evidencePassages, enabled: true, claimAlignment: true }
      : focused.evidencePassages;
    const citationMap = new Map(passagesExtracted?.state?.citationMap || []);
    const passageArtifacts = {
      findings,
      passages: state.passages || [],
      sources: state.sources || [],
      citationMap,
      evidenceStore: state.evidenceStore || passagesExtracted?.state?.evidenceStore || null,
    };
    const readiness = exploratoryLoop?.readiness || focusedControl?.readiness || null;
    const stopReason = budget.controllerStopReason || exploratoryLoop?.stopReason || state.reportContract?.stopReason || null;
    const stopDetail = budget.controllerStopDetail || exploratoryLoop?.stopDetail || null;
    const controlProfile = focusedControl?.profile || exploratoryLoop?.profile || {};
    const contractUnavailable = Boolean(
      controlProfile.contractUnavailable
      || focusedControl?.contractUnavailable
      || exploratoryLoop?.profile?.contractUnavailable,
    );
    const focusedFailures = focusedControl?.readiness?.failures || [];
    const snippetOnlyKeys = listSnippetOnlyCitationKeys(findings);
    const materialBlockedSlots = (exploratoryLoop?.recovery?.blockedGaps || []).filter((entry) => {
      const gap = gaps.find((item) => item.id === entry.gapId);
      return gap && !gap.rollup;
    });
    const limitationBase = {
      gaps,
      readiness,
      stopReason,
      stopDetail,
      budget: budget.snapshot(),
      findings,
      strategy,
      brief: resolvedBrief,
      snippetOnlyKeys,
      contractUnavailable,
      secondaryOnly: Boolean(exploratoryLoop?.secondaryOnlyClaims?.length),
      reprintOnly: findings.flatMap((finding) => finding.sources || []).some((source) => (
        source.evidenceTier === 'reprint'
        || source.retrievedVia === 'archive'
        || source.retrievedVia === 'google_cache'
        || source.tier === 'reprint'
      )),
      blockedHosts: plannerFactsFromSnapshot(exploratoryLoop?.transportMemory || focusedControl?.transportMemory || {}).blockedHosts,
      unmetRequiredHosts: (readiness?.failures || [])
        .filter((failure) => failure.code === 'required_host_missing')
        .flatMap((failure) => failure.hostDiagnostics || []),
      degraded: findings.some((finding) => finding?.degraded),
      extra: [
        exploratoryLoop?.unresolvedGaps?.length
          ? `Unresolved gaps: ${exploratoryLoop.unresolvedGaps.map((gap) => `${gap.id} (${gap.status}) ${gap.question}`).join('; ')}`
          : null,
        materialBlockedSlots.length
          ? `Blocked slots: ${materialBlockedSlots.map((gap) => (
            `${gap.gapId}${gap.answerSlot ? ` (${gap.answerSlot})` : ''}: ${gap.blockedReason}`
          )).join('; ')}.`
          : null,
      ].filter(Boolean),
    };
    let canonical = buildResearchLimitations(limitationBase);
    let reportLimitations = state.limitations?.length ? state.limitations : canonical.limitations;
    const reportContract = state.reportContract || buildReportContract({
      gaps,
      brief: resolvedBrief,
      readiness,
      strategy,
      stopReason,
    });
    const openJudgment = reportContract.openJudgment;
    const incompleteContract = reportContract.incompleteContract;
    let reportPlan = state.reportPlan || buildReportPlan({
      contract: reportContract,
      findings,
      passages: passageArtifacts.passages,
      citationMap: passageArtifacts.citationMap,
      brief: resolvedBrief,
      limitations: reportLimitations,
      query,
      gaps,
    });
    const preReport = evaluatePreReport({ findings, gaps, query });
    const trace = Array.isArray(state.trace) ? [...state.trace] : [];
    const appendTrace = Array.prototype.push.bind(trace);
    Object.defineProperty(trace, 'push', {
      enumerable: false,
      configurable: false,
      value: (...entries) => {
        for (const entry of entries) recorder.event('trace', entry);
        return appendTrace(...entries);
      },
    });
    const { llm } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      recorder,
      llmCallSequence: maxRecordedCallSequence(sessionDir, 'llm'),
      searchCallSequence: maxRecordedCallSequence(sessionDir, 'search'),
      onLlmEvent: (event) => {
        trace.push({
          step: trace.length + 1,
          action: 'llm_call',
          reasonCode: event.purpose,
          ...event,
          createdAt: new Date().toISOString(),
        });
        emit({
          stage: event.status === 'started' ? 'llm_call_started' : 'llm_call_finished',
          ...event,
        });
      },
    });
    emit({ stage: 'synthesizing_report' });
    recorder.event('session_resume_report', {
      strategy,
      query,
      fromCheckpoint: pre.checkpoint?.checkpointId || null,
    });
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget, fetch: createHttpFetch(settings?.http?.proxy), recorder,
      onEvent: (event) => {
        trace.push({ step: trace.length + 1, action: event.operation, reasonCode: `${event.operation}_${event.status}`, ...event, createdAt: new Date().toISOString() });
        emit({ stage: `${event.operation}_${event.status}`, ...event });
      },
    });
    try {
      return await finalizePreparedReport({
        embeddingStats: pre.state.embeddingStats || null,
        embedding: researchProviders.embedding,
        llm,
        signal,
        emit,
        recorder,
        budget,
        settings,
        strategy,
        query,
        resolvedBrief,
        findings,
        gaps,
        passageArtifacts,
        reportSettings,
        evidenceOptions,
        exploratoryLoop,
        focusedControl,
        preReport,
        readiness,
        stopReason,
        stopDetail,
        controlProfile,
        contractUnavailable,
        focusedFailures,
        limitationBase,
        reportContract,
        reportPlan,
        openJudgment,
        incompleteContract,
        reportLimitations,
        canonical,
        budgetBeforeReport,
        trace,
      });
    } finally {
      await closeHeadlessPool().catch(() => {});
    }
  }

  async resumeReportFromStrategyComplete({
    sessionDir,
    settings,
    signal,
    onProgress = () => {},
    llm: providedLlm,
    search: providedSearch,
    recorder: providedRecorder,
    checkpoint,
  }) {
    const state = checkpoint?.state;
    if (!state) {
      throw new Error('Cannot resume report: strategy-complete checkpoint is missing.');
    }
    const strategy = state.strategy || settings?.research?.strategy || 'exploratory';
    const query = state.query;
    const brief = state.brief || researchBriefFromInput(query, { depth: strategy });
    const findings = Array.isArray(state.findings) ? state.findings : [];
    const control = state.control || null;
    if (control && strategy === 'exploratory' && !findings.exploratoryLoop) {
      Object.defineProperty(findings, 'exploratoryLoop', {
        value: control,
        enumerable: false,
        configurable: true,
      });
    }
    if (control && strategy === 'focused' && !findings.researchControl) {
      Object.defineProperty(findings, 'researchControl', {
        value: control,
        enumerable: false,
        configurable: true,
      });
    }
    const recorder = recorderOrNoop(providedRecorder);
    const emit = createProgressEmitter(onProgress);
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || { async search() { return []; } };
    const budget = new BudgetManager(settings, emit);
    if (state.budget) budget.restoreCheckpoint(state.budget);
    const focused = resolveFocusedSettings(settings);
    const queryMemory = new QueryMemory({
      ...focused.queryMemory,
      onSkip: () => {},
    });
    if (state.queryMemory) queryMemory.restoreCheckpoint(state.queryMemory);
    const trace = Array.isArray(state.trace) ? [...state.trace] : [];
    const appendTrace = Array.prototype.push.bind(trace);
    Object.defineProperty(trace, 'push', {
      enumerable: false,
      configurable: false,
      value: (...entries) => {
        for (const entry of entries) recorder.event('trace', entry);
        return appendTrace(...entries);
      },
    });
    const { llm } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      recorder,
      llmCallSequence: maxRecordedCallSequence(sessionDir, 'llm'),
      searchCallSequence: maxRecordedCallSequence(sessionDir, 'search'),
      onLlmEvent: (event) => {
        trace.push({
          step: trace.length + 1,
          action: 'llm_call',
          reasonCode: event.purpose,
          ...event,
          createdAt: new Date().toISOString(),
        });
        emit({
          stage: event.status === 'started' ? 'llm_call_started' : 'llm_call_finished',
          ...event,
        });
      },
    });
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      fetch: proxiedFetch,
      recorder,
    });
    recorder.event('session_resume_report', {
      strategy,
      query,
      fromCheckpoint: checkpoint.checkpoint?.checkpointId || null,
      via: 'strategy-complete',
    });
    try {
      emit({ stage: 'research_started' });
      return await continueAfterStrategy({
        findings,
        strategy,
        query,
        brief,
        settings,
        llm,
        signal,
        emit,
        recorder,
        budget,
        queryMemory,
        researchProviders,
        focused,
        trace,
      });
    } finally {
      await closeHeadlessPool().catch(() => {});
    }
  }

  async resumeExploreFromSession({
    sessionDir,
    settings,
    signal,
    onProgress = () => {},
    llm: providedLlm,
    search: providedSearch,
    recorder: providedRecorder,
    plan,
    extraSearches = 0,
    extraReads = 0,
  }) {
    const checkpoint = plan?.mode === 'mid-loop' ? migrateUnfinishedLegacyState(plan.checkpoint.state) : plan?.checkpoint?.state;
    if (!checkpoint) {
      throw new Error('Cannot resume explore: checkpoint state is missing.');
    }
    const query = checkpoint.query;
    const strategy = 'exploratory';
    const brief = checkpoint.brief || researchBriefFromInput(query, { depth: strategy });
    const recorder = recorderOrNoop(providedRecorder);
    if (checkpoint.executionVersion === 2) recorder.enableRecovery?.(plan.checkpoint.checkpoint.checkpointId);
    if (checkpoint.migration && plan.checkpoint.state.executionVersion !== 2) recorder.checkpoint('legacy-state-migrated', checkpoint);
    const emit = createProgressEmitter(onProgress);
    const proxiedFetch = createHttpFetch(settings?.http?.proxy);
    const rawLlm = providedLlm || createLlmProvider(settings);
    const rawSearch = providedSearch || createSearchEngine(settings);
    const budget = new BudgetManager(settings, emit);
    if (checkpoint.budget) budget.restoreCheckpoint(checkpoint.budget);
    const focused = resolveFocusedSettings(settings);
    const trace = [];
    const appendTrace = Array.prototype.push.bind(trace);
    Object.defineProperty(trace, 'push', {
      enumerable: false,
      configurable: false,
      value: (...entries) => {
        for (const entry of entries) recorder.event('trace', entry);
        return appendTrace(...entries);
      },
    });
    const queryMemory = new QueryMemory({
      ...focused.queryMemory,
      onSkip: (event) => trace.push({
        step: trace.length + 1,
        action: 'query_skipped_duplicate',
        ...event,
        createdAt: new Date().toISOString(),
      }),
    });
    if (checkpoint.queryMemory) queryMemory.restoreCheckpoint(checkpoint.queryMemory);
    const { llm, search } = wrapProvidersWithBudget({
      llm: rawLlm,
      search: rawSearch,
      budget,
      recorder,
      llmCallSequence: maxRecordedCallSequence(sessionDir, 'llm'),
      searchCallSequence: maxRecordedCallSequence(sessionDir, 'search'),
      onLlmEvent: (event) => {
        trace.push({
          step: trace.length + 1,
          action: 'llm_call',
          reasonCode: event.purpose,
          ...event,
          createdAt: new Date().toISOString(),
        });
        emit({
          stage: event.status === 'started' ? 'llm_call_started' : 'llm_call_finished',
          ...event,
        });
      },
    });
    const researchProviders = createResearchProviders(settings?.research?.providers || {}, {
      budget,
      fetch: proxiedFetch,
      recorder,
      onEvent: (event) => {
        const action = event.operation === 'embed' ? 'embed' : 'rerank';
        trace.push({
          step: trace.length + 1,
          action,
          reasonCode: `${event.operation}_${event.status}`,
          ...event,
          createdAt: new Date().toISOString(),
        });
      },
    });
    if (researchProviders.embedding && queryMemory) {
      queryMemory.similarityProvider = researchProviders.embedding;
      queryMemory.semanticDedup = true;
    }
    recorder.event('session_resume_explore', {
      strategy,
      query,
      mode: plan.mode,
      fromCheckpoint: plan.checkpoint?.checkpoint?.checkpointId
        || plan.checkpoint?.checkpointId
        || null,
      extraSteps: plan.extraSteps || 0,
    });
    try {
      emit({ stage: 'research_started' });
      let findings;
      try {
        findings = await runExploratoryLoop({
          query,
          brief,
          settings,
          llm,
          search,
          signal,
          emit,
          budget,
          queryMemory,
          trace,
          researchProviders,
          recorder,
          restoredCheckpoint: checkpoint,
          continueExplore: plan.mode === 'continue-explore',
          extraSteps: plan.extraSteps || 0,
          extraSearches,
          extraReads,
        });
      } catch (error) {
        if (error?.name !== 'BudgetExceededError' && !(error instanceof BudgetExceededError)) throw error;
        findings = [];
        trace.push({
          step: trace.length + 1,
          action: 'research_stopped',
          reasonCode: 'budget_exhausted',
          kind: error.kind,
          createdAt: new Date().toISOString(),
        });
      }
      return await continueAfterStrategy({
        findings,
        strategy,
        query,
        brief,
        settings,
        llm,
        signal,
        emit,
        recorder,
        budget,
        queryMemory,
        researchProviders,
        focused,
        trace,
      });
    } finally {
      await closeHeadlessPool().catch(() => {});
    }
  }
}
