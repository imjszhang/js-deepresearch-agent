import {
  hasUsableResearchContract,
  inferResearchProfile,
  planResearchProfile,
} from './adaptive/research-profile.mjs';
import { mergeResearchBrief, researchBriefFromInput } from './research-brief.mjs';

export async function planAndNormalizeContract({
  llm,
  query,
  incomingBrief,
  settings,
  signal,
  evidenceScope,
  depth = 'focused',
} = {}) {
  const briefInput = incomingBrief || researchBriefFromInput(query, { depth });
  let profile = inferResearchProfile({ ...briefInput, query }, { settings, evidenceScope, depth });
  profile.brief = mergeResearchBrief(briefInput, profile.brief, { query, depth });
  profile = await planResearchProfile({ llm, query, profile, signal, settings, evidenceScope });
  profile.brief = mergeResearchBrief(briefInput, profile.brief, { query, depth });
  if (briefInput.requiredAnswerSlots?.length) {
    profile.brief.contractOrigin = profile.brief.contractOrigin || 'user';
  } else if (profile.brief.requiredAnswerSlots?.length) {
    profile.brief.contractOrigin = profile.brief.contractOrigin || 'planner';
  }
  const brief = profile.brief;
  const slots = brief.requiredAnswerSlots || [];
  const usable = hasUsableResearchContract(profile, brief);
  const contractUnavailable = Boolean(profile.contractUnavailable) && !slots.length;
  profile.contractUnavailable = contractUnavailable;
  return {
    profile,
    brief,
    slots,
    usable,
    contractUnavailable,
    contractRetried: Boolean(profile.contractRetried),
    contractFailure: profile.contractFailure || null,
  };
}

export function applyContractGaps(state, contract = {}, { maxGaps } = {}) {
  const { brief, profile, slots = [] } = contract;
  if (profile) {
    state.profile = profile;
    state.gaps[0] = {
      ...state.gaps[0],
      requiredHosts: profile.requiredHosts ?? state.gaps[0].requiredHosts,
      requiredHostMode: profile.requiredHostMode ?? state.gaps[0].requiredHostMode,
      preferredHosts: profile.preferredHosts ?? state.gaps[0].preferredHosts,
      requiredSourceTypes: profile.requiredSourceTypes ?? state.gaps[0].requiredSourceTypes,
      minIndependentSources: profile.minIndependentSources || state.gaps[0].minIndependentSources || 1,
    };
  }
  if (brief) state.brief = brief;
  const explicitSlots = slots.length > 0;
  if (explicitSlots) {
    state.gaps[0].rollup = true;
    state.gaps[0].kind = 'root';
    state.gaps[0].requiredSlot = false;
    state.gaps[0].requiredHosts = [];
    state.gaps[0].requiredSourceTypes = [];
  }
  for (const slot of slots) {
    if (state.gaps.some((gap) => gap.contractSlotId === slot.id)) continue;
    state.addGap(slot.question || slot.answerSlot, slot.priority || 'normal', {
      contractSlotId: slot.id,
      answerSlot: slot.answerSlot,
      claimFamily: slot.claimFamily,
      requiredHosts: slot.requiredHosts,
      requiredHostMode: slot.requiredHostMode,
      preferredHosts: slot.preferredHosts,
      requiredSourceTypes: slot.requiredSourceTypes,
      evidenceCriteria: slot.evidenceCriteria,
      requiredSlot: slot.requiredSlot !== false && explicitSlots,
      kind: explicitSlots ? 'slot' : 'followup',
      deduplicate: !explicitSlots,
    });
  }
  state.maxContractGaps = slots.length + 1;
  state.maxDynamicGaps = maxGaps ? Math.max(0, maxGaps - 1) : 0;
  return state.gaps;
}
