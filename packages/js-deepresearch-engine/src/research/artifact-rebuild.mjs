import { EvidenceStore } from './evidence-store.mjs';
import { ResearchState } from './adaptive/research-state.mjs';
import { createResearchRequest } from './research-request.mjs';
import { researchBriefFromInput } from './research-brief.mjs';
import { planAndNormalizeContract, applyContractGaps } from './research-contract.mjs';
import { judgeOpenSlotSupport, applySlotSupportJudgments, selectSlotPassages } from './gap-slot-support.mjs';
import { BudgetManager, wrapProvidersWithBudget } from './budget-manager.mjs';
import { maxRecordedCallSequence, recorderOrNoop, loadNamedCheckpoint } from './run-recorder.mjs';
import { createRunExecutionConfig } from './run-execution-config.mjs';
import { finalizeCanonicalReport } from './canonical-report.mjs';
import { resolveReportSettings } from './report-settings.mjs';
import crypto from 'node:crypto';

// Explicit diagnostic mode. Only a query and canonical bodies cross the input
// boundary: previous findings, claims, scores, inspections and gold are excluded.
export async function rebuildFromEvidence({ query, evidenceStore, inputPin, settings, llm: rawLlm, recorder: suppliedRecorder, signal }) {
  const recorder = recorderOrNoop(suppliedRecorder);
  const identity = crypto.createHash('sha256').update(JSON.stringify([query, inputPin, new EvidenceStore(evidenceStore).export()])).digest('hex');
  const start = recorder.sessionDir ? loadNamedCheckpoint(recorder.sessionDir, 'artifact-rebuild-start')?.state : null;
  if (start && start.identity !== identity) throw new Error('ARTIFACT_REBUILD_INPUT_CHANGED');
  const completed = recorder.sessionDir ? loadNamedCheckpoint(recorder.sessionDir, 'research-complete')?.state.result : null;
  if (completed) {
    if (completed.researchMode !== 'artifact_rebuild') throw new Error('ARTIFACT_REBUILD_SESSION_MODE');
    return completed;
  }
  const savedBoundary = recorder.sessionDir ? loadNamedCheckpoint(recorder.sessionDir, 'artifact-rebuild-step') : null;
  const saved = savedBoundary?.state;
  if (recorder.sessionDir && start) recorder.enableRecovery?.(savedBoundary?.checkpoint.checkpointId
    || loadNamedCheckpoint(recorder.sessionDir, 'artifact-rebuild-start').checkpoint.checkpointId);
  const config = { ...settings, research: { ...settings.research, strategy: 'focused', report: { ...settings.research?.report, maxOutputTokens: 16000 },
    exploratory: { minLlmTokens: 0, maxLlmTokens: 0 }, budget: { maxLlmTokens: 100000, maxTotalLlmTokens: 100000 } } };
  const executionConfig = createRunExecutionConfig(config);
  if (start?.executionConfig?.configHash && start.executionConfig.configHash !== executionConfig.configHash) throw new Error('ARTIFACT_REBUILD_CONFIG_CHANGED');
  recorder.setExecutionConfig?.(executionConfig);
  const budget = new BudgetManager(config); budget.executionVersion = 2;
  const ledger = recorder.sessionDir ? loadNamedCheckpoint(recorder.sessionDir, 'budget-ledger')?.state.budget : null;
  if (ledger || saved?.budget) budget.restoreCheckpoint(ledger || saved.budget);
  const { llm } = wrapProvidersWithBudget({ llm: rawLlm, search: { search() { throw new Error('ARTIFACT_REBUILD_NETWORK_FORBIDDEN'); } }, budget, recorder,
    llmCallSequence: recorder.sessionDir ? maxRecordedCallSequence(recorder.sessionDir, 'llm') : 0 });
  let state;
  if (saved) {
    state = new ResearchState({ query, settings: config, budget });
    state.restoreCheckpoint(saved.researchState);
  } else {
    const incomingBrief = start?.incomingBrief || { ...researchBriefFromInput(query), executionVersion: 2, request: createResearchRequest(query) };
    if (!start) recorder.checkpoint('artifact-rebuild-start', { identity, inputPin, incomingBrief, executionConfig, budget: budget.exportCheckpoint() });
    const contract = await planAndNormalizeContract({ query, incomingBrief, settings: config, signal, llm, evidenceScope: 'local', depth: 'focused' });
    state = new ResearchState({ query, settings: config, budget, brief: contract.brief, profile: contract.profile });
    applyContractGaps(state, contract);
    const bodiesOnly = new EvidenceStore(evidenceStore).export();
    bodiesOnly.inspections = []; bodiesOnly.associations = [];
    state.evidenceStore = new EvidenceStore(bodiesOnly);
    for (const gap of state.gaps.filter(g => !g.rollup)) {
      // A body is a candidate context, not a verified answer. Slot inspection
      // decides contribution; the shared claim verifier decides publication.
      for (const version of state.evidenceStore.versions.values()) state.findings.push({
        id: 'rebuild-' + gap.id + '-' + version.documentVersionId, gapId: gap.id, contractSlotId: gap.contractSlotId,
        question: gap.question, sources: [{ id: version.sourceId, canonicalSourceId: version.sourceId, documentVersionId: version.documentVersionId,
          url: version.url, title: version.title, content: state.evidenceStore.body(version.documentVersionId), fetchStatus: 'ok', contentOrigin: 'provided' }],
      });
    }
  }
  if (ledger) budget.restoreCheckpoint(ledger);
  const checkpoint = () => recorder.checkpoint('artifact-rebuild-step', { researchMode: 'artifact_rebuild', inputPin,
    researchState: state.exportCheckpoint(), budget: budget.exportCheckpoint() });
  checkpoint();
  while (true) {
    signal?.throwIfAborted();
    const pending = state.gaps.filter(g => !g.rollup && selectSlotPassages(g, state.findings, {
      evidenceStore: state.evidenceStore, inspectUnseen: true, topK: 5, query, brief: state.brief, profile: state.profile }).length);
    if (!pending.length) break;
    const before = state.evidenceStore.inspections.size;
    const reviewed = await judgeOpenSlotSupport({ llm, signal, query, gaps: pending.slice(0, 2), findings: state.findings,
      brief: state.brief, profile: state.profile, evidenceStore: state.evidenceStore, inspectUnseen: true, cache: state.slotSupportCache });
    applySlotSupportJudgments(state.gaps, reviewed.judgments);
    state.syncGapCoverage();
    checkpoint();
    if (state.evidenceStore.inspections.size === before) break;
  }
  state.refreshBudgetView({ budget });
  const versions = [...state.evidenceStore.versions.values()];
  return finalizeCanonicalReport({ llm, signal, recorder, budget, emit() {}, strategy: 'focused', query,
    researchMode: 'artifact_rebuild', rebuildInput: { pin: inputPin, documentVersions: versions.map(v => v.documentVersionId) },
    resolvedBrief: state.brief, gaps: state.gaps, findings: state.evidenceStore.compactFindings(state.findings), trace: [],
    readiness: state.readiness, stopReason: 'safety_cap', stopDetail: 'fixed_body_inspection_complete',
    passageArtifacts: { evidenceStore: state.evidenceStore.export(), passages: [...state.evidenceStore.passages.values()],
      sources: versions.map(v => ({ id: v.sourceId, url: v.url, title: v.title })) },
    reportSettings: resolveReportSettings(config) });
}
