import { resolveCompletionStatus } from './as-of.mjs';
import { isRequiredSlot } from './gap-state.mjs';

export const REPORT_CONTRACT_VERSION = 1;

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function slotId(slot) {
  return slot?.id || null;
}

function isClosedSlot(slot) {
  return slot?.status === 'verified' || slot?.status === 'closed' || slot?.evidenceStatus === 'verified';
}

function isOpenOrBlocked(slot) {
  return !isClosedSlot(slot);
}

function isJudgmentQuestion(brief = {}, gaps = []) {
  if (brief?.queryShape === 'judgment') return true;
  return (gaps || []).some((gap) => (
    isRequiredSlot(gap) && /judgment/i.test(String(gap.answerSlot || gap.contractSlotId || ''))
  ));
}

function listRequiredSlots(gaps = []) {
  return (gaps || []).filter((gap) => isRequiredSlot(gap));
}

function summarizeSlot(slot) {
  return {
    id: slot.id,
    question: slot.question || '',
    status: slot.status || 'open',
    evidenceStatus: slot.evidenceStatus || slot.status || 'open',
    importance: slot.importance || 'normal',
    requiredSlot: Boolean(slot.requiredSlot),
    kind: slot.kind || 'finding',
    rollup: Boolean(slot.rollup),
    requiredHosts: asList(slot.requiredHosts),
    preferredHosts: asList(slot.preferredHosts),
    requiredHostMode: slot.requiredHostMode || 'any',
  };
}

export function buildReportContract({
  gaps = [],
  brief = {},
  readiness = {},
  strategy = '',
  stopReason = '',
} = {}) {
  const requiredSlots = listRequiredSlots(gaps);
  const verifiedRequiredSlots = requiredSlots.filter((slot) => isClosedSlot(slot));
  const openRequiredSlots = requiredSlots.filter((slot) => slot.status === 'open' || slot.status === 'missing');
  const blockedRequiredSlots = requiredSlots.filter((slot) => slot.status === 'blocked');
  const unresolvedRequiredSlots = requiredSlots.filter(isOpenOrBlocked);
  const judgmentQuestion = isJudgmentQuestion(brief, gaps);
  const openJudgment = Boolean(judgmentQuestion && unresolvedRequiredSlots.length);
  const closedJudgment = Boolean(judgmentQuestion && unresolvedRequiredSlots.length === 0);
  const incompleteContract = unresolvedRequiredSlots.length > 0;
  const completionStatus = resolveCompletionStatus({
    strategy,
    stopReason,
    gaps,
    readiness,
  });
  const judgmentMode = closedJudgment
    ? 'closed_judgment'
    : (openJudgment ? 'open_judgment' : 'not_judgment');
  const narrativeMode = incompleteContract
    ? 'incomplete'
    : (closedJudgment ? 'closed_judgment' : 'complete');

  return {
    schemaVersion: REPORT_CONTRACT_VERSION,
    strategy: strategy || '',
    stopReason: stopReason || '',
    completionStatus,
    judgmentQuestion,
    judgmentMode,
    narrativeMode,
    openJudgment,
    closedJudgment,
    incompleteContract,
    requiredInKeyFindings: closedJudgment || (!judgmentQuestion && !incompleteContract),
    allowBackgroundFacts: true,
    allowKeyFindings: !openJudgment,
    requiredSlots: requiredSlots.map(summarizeSlot),
    verifiedRequiredSlots: verifiedRequiredSlots.map(summarizeSlot),
    openRequiredSlots: openRequiredSlots.map(summarizeSlot),
    blockedRequiredSlots: blockedRequiredSlots.map(summarizeSlot),
    unresolvedRequiredSlots: unresolvedRequiredSlots.map(summarizeSlot),
    verifiedSlotIds: verifiedRequiredSlots.map(slotId).filter(Boolean),
    unresolvedSlotIds: unresolvedRequiredSlots.map(slotId).filter(Boolean),
    readiness: {
      ready: Boolean(readiness?.ready ?? readiness?.pass),
      reason: readiness?.reason || null,
      blockingGaps: asList(readiness?.blockingGaps).map((gap) => gap.id || gap).filter(Boolean),
    },
  };
}

export function formatContractPromptBlock(contract = {}) {
  const lines = [
    `Report contract: ${contract.narrativeMode || 'complete'}.`,
    `Judgment mode: ${contract.judgmentMode || 'not_judgment'}.`,
    `Completion status: ${contract.completionStatus || 'complete'}.`,
  ];

  if (contract.closedJudgment) {
    lines.push('Required judgment slots are verified/supported. Do not describe them as unresolved, open, or background-only.');
    lines.push('Write the verified slot-bound answers in keyFindings.');
  } else if (contract.openJudgment) {
    lines.push('Required judgment slots remain open. Do not write a final research judgment in keyFindings.');
    lines.push('Use summary and backgroundFacts only for verified first-party source facts. Put unresolved judgment in caveats.');
  } else if (contract.incompleteContract) {
    lines.push('Some required slots remain unresolved. Do not invent a complete answer.');
  } else {
    lines.push('Required slots are closed. Write the verified answers in keyFindings.');
  }

  if (contract.verifiedRequiredSlots?.length) {
    lines.push('Verified required slots:');
    for (const slot of contract.verifiedRequiredSlots) {
      lines.push(`- ${slot.id}: ${slot.question} [${slot.status}/${slot.evidenceStatus}]`);
    }
  }

  if (contract.unresolvedRequiredSlots?.length) {
    lines.push('Unresolved required slots (do not treat as answered):');
    for (const slot of contract.unresolvedRequiredSlots) {
      lines.push(`- ${slot.id}: ${slot.question} [${slot.status}]`);
    }
  }

  return lines.join('\n');
}
