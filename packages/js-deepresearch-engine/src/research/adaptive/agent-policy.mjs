const ACTION_SCHEMA = '{"action":"search|read|reflect|answer|stop","reasonCode":"short_code","gapId":"gap-1","query":"...","sourceIds":["..."],"gapQuestion":"..."}';

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

export async function decideAdaptiveAction({ llm, state, signal }) {
  const response = await llm.complete({
    purpose: 'agent_decision',
    signal,
    temperature: 0,
    messages: [{ role: 'system', content: [
      'You are a bounded research agent. Choose exactly one next action.',
      'Rerank scores are optional observations, never mandatory source choices.',
      'Prefer reading evidence before answering. Use reflect to add or revise one research gap.',
      `Return JSON only: ${ACTION_SCHEMA}`,
    ].join('\n') }, { role: 'user', content: JSON.stringify(state.snapshot()) }],
  });
  return extractJson(response);
}

export function fallbackAdaptiveAction(state) {
  if (state.candidates.size === 0) return { action: 'search', query: state.query, gapId: 'gap-1', reasonCode: 'fallback_initial_search' };
  const unread = [...state.candidates.keys()].filter((id) => !state.readSourceIds.has(id));
  if (unread.length) return { action: 'read', sourceIds: unread.slice(0, 1), gapId: state.candidates.get(unread[0])?.gapId, reasonCode: 'fallback_read_evidence' };
  return { action: 'answer', reasonCode: 'fallback_evidence_available' };
}
