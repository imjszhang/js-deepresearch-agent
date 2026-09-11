// Test authors specify expected ranges; mocks emit the public locator protocol.
// Never used by production, and intentionally invalid ranges stay invalid.
export function selectedFact(block, fact) {
  const { span, contextSpans = [], ...rest } = fact;
  const select = range => {
    const quote = block.text.slice(...range);
    const unit = block.locator.units.filter(u => {
      const text = block.text.slice(...u.range);
      return text.includes(quote) && text.indexOf(quote) === text.lastIndexOf(quote);
    }).sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]))[0];
    return { unitId: unit?.id || 'invalid-unit', quote };
  };
  if (!span || block.text.slice(...span) !== fact.quote) return { ...rest, unitId: 'invalid-unit' };
  // Repeated identical lines must choose the line at the authored range.
  const line = block.units?.find(u => u.span[0] === span[0] && u.span[1] === span[1]);
  const lineIndex = line && block.units.indexOf(line);
  const lines = block.locator.units.filter(u => u.containerId);
  return { ...rest, ...select(span), ...(line && lines[lineIndex] ? { unitId: lines[lineIndex].id } : {}), contextLocators: contextSpans.map(select) };
}

export function faithfulBindings(input) {
  return { bindings: input.bindings.map(b => ({ id: b.id, status: 'faithful' })) };
}
