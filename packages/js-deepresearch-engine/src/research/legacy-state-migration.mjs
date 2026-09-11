import { EvidenceStore } from './evidence-store.mjs';
import { ActionScheduler } from './adaptive/action-scheduler.mjs';

// Only unfinished legacy exploration is migrated. Its contract remains frozen;
// completed results and terminal report resumes continue through the v1 reader.
export function migrateUnfinishedLegacyState(checkpoint) {
  if (checkpoint.executionVersion === 2 || checkpoint.schemaVersion === 2) return checkpoint;
  const state = globalThis.structuredClone(checkpoint);
  const store = new EvidenceStore();
  store.captureFindings(state.findings || []);
  state.gaps = (state.gaps || []).map((gap) => {
    const support = gap.slotSupport;
    const refs = [];
    for (const finding of state.findings || []) {
      if (finding.gapId !== gap.id && (!gap.contractSlotId || finding.contractSlotId !== gap.contractSlotId)) continue;
      for (const source of finding.sources || []) {
        if (!source.documentVersionId || !support?.quote) continue;
        const content = store.body(source.documentVersionId);
        const start = content.indexOf(support.quote);
        if (start < 0) continue;
        refs.push(store.addPassage(source.documentVersionId, start, start + support.quote.length));
      }
    }
    return { ...gap, schemaVersion: 6, origin: 'legacy_unknown', taskType: gap.taskType || (state.brief?.queryShape === 'judgment' ? 'derived_judgment' : 'fact'),
      ...(support ? { slotSupport: { ...support, quoteAnchored: refs.length > 0,
        supportingPassageIds: refs.map((item) => item.id), evidenceSourceIds: [...new Set(refs.map((item) => item.sourceId))] } } : {}) };
  });
  state.brief = { ...state.brief, executionVersion: 2, contractOrigin: 'legacy_unknown',
    requiredAnswerSlots: (state.brief?.requiredAnswerSlots || []).map((slot) => ({ ...slot, origin: 'legacy_unknown' })) };
  state.profile = { ...state.profile, brief: state.brief };
  state.executionVersion = 2; state.schemaVersion = 2;
  state.evidenceStore = store.export();
  state.findings = store.compactFindings(state.findings || []);
  state.scheduler = new ActionScheduler().export();
  state.budget = { ...state.budget, executionVersion: 2, legacyUsageUnknown: Boolean(state.budget?.unknown?.llmTokens) };
  state.migration = { fromExecutionVersion: 1, toExecutionVersion: 2, contractPolicy: 'frozen_legacy_unknown', reanchoredPassages: store.passages.size };
  return state;
}
