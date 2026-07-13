import { hostnameOf } from './research-state.mjs';

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
      'Do not repeat the previous action (lastAction) and never answer immediately after a search.',
      'Never repeat or closely paraphrase a query listed in searchedQueries; propose a genuinely different query instead.',
      'Use the knowledge entries to judge whether collected evidence already answers the open gaps.',
      'When the knowledge entries already cover every open gap, choose answer instead of gathering more evidence.',
      'When stepsRemaining is 3 or less, prioritize answer over further exploration.',
      `Return JSON only: ${ACTION_SCHEMA}`,
    ].join('\n') }, { role: 'user', content: JSON.stringify(state.snapshot()) }],
  });
  return extractJson(response);
}

function readHostnames(state) {
  const hostnames = new Set();
  for (const id of state.readSourceIds) {
    const hostname = hostnameOf(state.candidates.get(id)?.url || id);
    if (hostname) hostnames.add(hostname);
  }
  return hostnames;
}

export function fallbackAdaptiveAction(state) {
  const rankedUnread = state.rankedCandidates().filter((candidate) => !state.readSourceIds.has(candidate.id));
  if (rankedUnread.length && state.lastAction !== 'read') {
    const alreadyRead = readHostnames(state);
    const pick = rankedUnread.find((candidate) => {
      const hostname = hostnameOf(candidate.url);
      return hostname && !alreadyRead.has(hostname);
    }) || rankedUnread[0];
    return { action: 'read', sourceIds: [pick.id], gapId: pick.gapId, reasonCode: 'fallback_read_evidence' };
  }
  if (state.candidates.size === 0) return { action: 'search', query: state.query, gapId: 'gap-1', reasonCode: 'fallback_initial_search' };
  if (state.lastAction !== 'reflect' && state.gaps.some((gap) => gap.status === 'open')) {
    return { action: 'reflect', reasonCode: 'fallback_reflect_gaps' };
  }
  return { action: 'answer', reasonCode: 'fallback_evidence_available' };
}

export async function evaluateAnswerReadiness({ llm, state, signal }) {
  try {
    const response = await llm.complete({
      purpose: 'answer_evaluation',
      signal,
      temperature: 0,
      messages: [{ role: 'system', content: [
        'You review whether collected research knowledge is sufficient to definitively answer the question.',
        'Fail only when a clearly important aspect of the question has no supporting knowledge at all.',
        'Return JSON only: {"pass":true|false,"missingAspect":"one concrete unanswered sub-question or empty string"}',
      ].join('\n') }, { role: 'user', content: JSON.stringify({
        query: state.query,
        gaps: state.gaps,
        knowledge: state.knowledge,
        findingsCount: state.findings.length,
      }) }],
    });
    const parsed = extractJson(response);
    if (!parsed || typeof parsed.pass !== 'boolean') return null;
    return { pass: parsed.pass, missingAspect: String(parsed.missingAspect || '').trim() };
  } catch {
    return null;
  }
}
