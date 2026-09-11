import { hash, span } from './schema.mjs';
export const LOCATOR_VERSION = 2;
const fail = (code, candidates = []) => { throw Object.assign(new Error(code), { code, candidates }); };

// Identity includes the unmodified UTF-16 text, its owner and original offset.
// Containers are never truncated to fit a batch. A budget failure is incomplete.
export function locatorCatalog(text, owner, baseOffset = 0) {
  const identity = { locatorVersion: LOCATOR_VERSION, owner, textHash: hash(text), baseOffset };
  const catalogHash = hash(identity), units = [];
  const add = (start, end, containerId = null) => {
    const id = `u-${hash([catalogHash, start, end]).slice(0, 20)}`;
    if (!units.some(u => u.id === id)) units.push({ id, text: text.slice(start, end), span: [start, end], containerId });
    return id;
  };
  const container = text.length ? add(0, text.length) : null;
  for (const m of text.matchAll(/[^\n]+/g)) if (m[0].trim()) add(m.index, m.index + m[0].length, container);
  return { ...identity, catalogHash, units };
}
export function locatorInput(catalog) {
  return { locatorVersion: LOCATOR_VERSION, catalogHash: catalog.catalogHash, owner: catalog.owner,
    // The enclosing block/source owns the only raw text copy. Ranges are
    // program-provided references, never positions that the model must invent.
    units: catalog.units.map(({ id, span, containerId }) => ({ id, range: span, containerId })) };
}
export function fragmentFor(catalog, range) {
  const container = catalog.units[0];
  const quote = span(container.text, range);
  return { fragmentId: `f-${hash([catalog.catalogHash, range]).slice(0, 20)}`, catalogHash: catalog.catalogHash,
    unitId: container.id, quote, span: range, context: container.text.slice(Math.max(0, range[0] - 32), Math.min(container.text.length, range[1] + 32)) };
}
export function resolveLocator(selection, catalog, offered = []) {
  if (!selection || typeof selection !== 'object') fail('locator_unknown_id');
  if (['span', 'start', 'end', 'contextSpans'].some(k => Object.hasOwn(selection, k))) fail('locator_numeric_position_forbidden');
  if (selection.catalogHash != null && selection.catalogHash !== catalog.catalogHash) fail('locator_catalog_mismatch');
  if (selection.owner != null && hash(selection.owner) !== hash(catalog.owner)) fail('locator_owner_mismatch');
  let range;
  if (selection.fragmentId) {
    const fragment = offered.find(f => f.fragmentId === selection.fragmentId && f.catalogHash === catalog.catalogHash);
    if (!fragment) fail('locator_unknown_id');
    const expected = fragmentFor(catalog, fragment.span);
    if (hash(expected) !== hash(fragment)) fail('locator_catalog_mismatch');
    if (selection.quote != null && selection.quote !== fragment.quote) fail('locator_quote_not_found');
    range = fragment.span;
  } else {
    const unit = catalog.units.find(u => u.id === selection.unitId);
    if (!unit) fail('locator_unknown_id');
    const quote = selection.quote;
    if (typeof quote !== 'string' || !quote.trim()) fail('locator_quote_not_found');
    const positions = [];
    for (let i = unit.text.indexOf(quote); i >= 0; i = unit.text.indexOf(quote, i + 1)) positions.push(i);
    if (!positions.length) fail('locator_quote_not_found');
    if (positions.length !== 1) fail('locator_ambiguous', positions.map(i => fragmentFor(catalog, [unit.span[0] + i, unit.span[0] + i + quote.length])));
    range = [unit.span[0] + positions[0], unit.span[0] + positions[0] + quote.length];
  }
  const text = catalog.units[0].text;
  const splitsPair = n => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]);
  if (range.some(splitsPair)) fail('locator_surrogate_boundary');
  const quote = span(text, range);
  return { quote, span: range, originalSpan: range.map(n => n + catalog.baseOffset), owner: catalog.owner,
    locatorVersion: LOCATOR_VERSION, catalogHash: catalog.catalogHash };
}
export function evidenceCatalog(source) {
  return locatorCatalog(source.text, { evidenceId: source.id, sourceId: source.sourceId ?? null,
    documentVersionId: source.documentVersionId ?? null, version: source.version ?? null, url: source.url ?? null }, source.startChar ?? source.span?.[0] ?? 0);
}
