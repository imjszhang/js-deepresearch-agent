import { locatorCatalog, locatorInput, resolveLocator } from './locators.mjs';
import { invariant } from './schema.mjs';
import { evaluatorMessages, conservativeRequestReservation, DEFAULT_REQUEST_RESERVATION } from './request-budget.mjs';

// Blocks are transport/coverage units of one report, not separate semantic
// owners. Offsets remain relative to each raw block until normalized to report
// coordinates. Every supplied block retains its complete unmodified text.
export function createReportContext(reportHash, blocks) {
  const catalogs = blocks.map(block => ({ block, catalog: locatorCatalog(block.text, { reportHash }, block.start) }));
  return { reportHash, catalogs,
    blocks: catalogs.map(({ block, catalog }) => ({ ...block, locator: locatorInput(catalog) })) };
}

export function resolveReportContext(selection, context, offered = []) {
  const matches = context.catalogs.filter(({ catalog }) => selection?.fragmentId
    ? offered.some(f => f.fragmentId === selection.fragmentId && f.catalogHash === catalog.catalogHash)
    : catalog.units.some(u => u.id === selection?.unitId));
  if (matches.length !== 1) throw Object.assign(new Error('locator_unknown_id'), { code: 'locator_unknown_id' });
  invariant(matches[0].catalog.owner.reportHash === context.reportHash, 'Report context identity mismatch');
  return resolveLocator(selection, matches[0].catalog, offered);
}

// Markdown headings supply structural candidate ancestry only. They do not
// establish semantic scope or license automatic inheritance of any condition.
function contextCandidates(context, targets) {
  const stack = [], ancestors = new Map();
  for (const block of context.blocks) {
    const heading = /^ {0,3}(#{1,6})(?:[\t ]+|$)/.exec(block.text);
    if (heading) while (stack.length && stack.at(-1).level >= heading[1].length) stack.pop();
    ancestors.set(block.id, stack.map(item => item.block).reverse());
    if (heading) stack.push({ level: heading[1].length, block });
  }
  const targetsSet = new Set(targets.map(b => b.id)), choices = new Map();
  for (const target of targets) {
    const i = context.blocks.findIndex(b => b.id === target.id);
    for (const candidate of [...(ancestors.get(target.id) || []), context.blocks[i - 1], context.blocks[i + 1]]) {
      if (candidate && !targetsSet.has(candidate.id)) choices.set(candidate.id, candidate);
    }
  }
  return [...choices.values()];
}

export function boundedReportContextInput(context, blocks, { instructions, maxOutputTokens = 4500,
  maxReservation = DEFAULT_REQUEST_RESERVATION } = {}) {
  const candidates = contextCandidates(context, blocks);
  const inputFor = selected => {
    const shown = new Set([...blocks, ...selected].map(b => b.id));
    const selectedSet = new Set(selected.map(b => b.id));
    return { reportHash: context.reportHash, contextScope: shown.size === context.blocks.length ? 'complete' : 'partial',
      omittedContextBlockCount: context.blocks.length - shown.size,
      omittedCandidateBlockIds: candidates.filter(b => !selectedSet.has(b.id)).map(b => b.id),
      blocks: blocks.map(b => ({ ...b, contextBlockIds: [...shown] })), contextBlocks: selected };
  };
  const selected = [];
  for (const candidate of candidates) {
    const trial = [...selected, candidate];
    if (conservativeRequestReservation(evaluatorMessages(instructions, inputFor(trial)), maxOutputTokens) <= maxReservation) selected.push(candidate);
  }
  return inputFor(selected);
}

export function providedReportContext(context, block) {
  invariant(Array.isArray(block.contextBlockIds) && block.contextBlockIds.includes(block.id), 'Report context scope missing');
  const allowed = new Set(block.contextBlockIds);
  return { reportHash: context.reportHash, catalogs: context.catalogs.filter(c => allowed.has(c.block.id)),
    blocks: context.blocks.filter(b => allowed.has(b.id)) };
}

// reviewItems can retain accepted siblings while retrying only failed targets.
// Those siblings' raw text was part of the original permitted context. Rehome
// it before freezing the actual retry input so it remains genuinely visible,
// without repeating either raw bodies or already accepted model assertions.
export function rehomeReportBlocks(baseInput, batchItems) {
  const targetIds = new Set(batchItems.map(b => b.id));
  const context = new Map((baseInput.contextBlocks || []).map(b => [b.id, b]));
  for (const block of baseInput.blocks.filter(b => !targetIds.has(b.id))) {
    const { id, text, start, locator, units } = block;
    context.set(id, { id, text, start, ...(locator ? { locator } : {}), ...(units ? { units } : {}) });
  }
  for (const id of targetIds) context.delete(id);
  return { ...baseInput, blocks: batchItems, contextBlocks: [...context.values()] };
}
