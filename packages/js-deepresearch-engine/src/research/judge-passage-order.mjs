import { judgeMaySend } from './judge-settings.mjs';

export const JUDGE_PASSAGE_ORDER_PURPOSE = 'judge_passage_order';

function batchGroups(groups, size) {
  const out = [];
  let current = [];
  let count = 0;
  for (const group of groups) {
    if (current.length && count + group.passages.length > size) { out.push(current); current = []; count = 0; }
    current.push(group);
    count += group.passages.length;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Reorders already selected passages so the most directly relevant come first.
 * The selected set never changes, no verdict is produced, and a group keeps its
 * original order unless every one of its passages received an answer.
 *
 * groups: [{ key, focus, passages: [{ id, text, url }] }]
 * returns Map(key -> ordered passage ids) for reordered groups only.
 */
export async function judgePassageOrder(judge, { groups = [], signal } = {}) {
  const orders = new Map();
  const trace = { requests: 0, degraded: 0, skippedLocal: 0, errorCodes: [] };
  if (!judge?.enabled?.('passageOrder')) return { orders, trace };
  const eligible = groups.filter((group) => {
    if (group.passages.length < 2 || group.passages.length > judge.batchSize) return false;
    if (group.passages.every((passage) => judgeMaySend(judge, passage.url))) return true;
    trace.skippedLocal += 1;
    return false;
  });
  for (const batch of batchGroups(eligible, judge.batchSize)) {
    const questions = {};
    batch.forEach((group, groupIndex) => group.passages.forEach((_, passageIndex) => {
      questions[`g${groupIndex}_p${passageIndex}`] = { type: 'noul', instructions: `Does passage \`p${passageIndex}\` of group \`g${groupIndex}\` in \`groups\` directly state facts that bear on that group's \`focus\`?` };
    }));
    const result = await judge.judge({
      purpose: JUDGE_PASSAGE_ORDER_PURPOSE,
      signal,
      state: { groups: batch.map((group, groupIndex) => ({ ref: `g${groupIndex}`, focus: group.focus,
        passages: group.passages.map((passage, passageIndex) => ({ ref: `p${passageIndex}`, text: passage.text })) })) },
      questions,
    });
    if (result.status !== 'completed') {
      trace.degraded += 1;
      if (result.errorCode) trace.errorCodes.push(result.errorCode);
      continue;
    }
    if (!result.cached) trace.requests += 1;
    batch.forEach((group, groupIndex) => {
      const ranked = group.passages.map((passage, index) => ({ id: passage.id, index, score: result.answers[`g${groupIndex}_p${index}`].noul }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      orders.set(group.key, ranked.map((item) => item.id));
    });
  }
  return { orders, trace };
}

export function applyPassageOrder(passages, order) {
  if (!order) return passages;
  const rank = new Map(order.map((id, index) => [id, index]));
  return passages.map((passage, index) => ({ passage, index }))
    .sort((a, b) => (rank.get(a.passage.id) ?? a.index) - (rank.get(b.passage.id) ?? b.index) || a.index - b.index)
    .map((entry) => entry.passage);
}
