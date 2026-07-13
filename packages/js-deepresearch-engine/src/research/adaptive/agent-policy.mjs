import { hostnameOf } from './research-state.mjs';

const ACTION_SCHEMA = '{"action":"search|read|reflect|answer|stop","reasonCode":"short_code","gapId":"gap-1","query":"...","queries":["..."],"sourceIds":["..."],"gapQuestion":"..."}';

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
      'Candidate "score" values are optional observations, never mandatory source choices.',
      'Top-ranked sources are read automatically after each search; use read only to pick additional promising sources the auto-read skipped.',
      'Prefer reading evidence before answering. Use reflect to add or revise one research gap.',
      'Prefer working on focusGapId unless another open gap is clearly more urgent.',
      'Do not repeat the previous action (lastAction) and never answer immediately after a search.',
      'A search action may include up to 3 distinct queries in "queries"; make them complementary, not paraphrases.',
      'A read action should include 2-4 sourceIds when several promising unread candidates exist.',
      'Never repeat or closely paraphrase a query listed in searchedQueries; propose a genuinely different query instead.',
      'If the research question compares multiple subjects, ensure searches and reads cover each subject; check knowledge for subjects with no dedicated evidence yet.',
      'Use the knowledge entries to judge whether collected evidence already answers the open gaps.',
      'When the knowledge entries already cover every open gap, choose answer instead of gathering more evidence.',
      'When stepsRemaining is 3 or less, prioritize answer over further exploration.',
      `Return JSON only: ${ACTION_SCHEMA}`,
    ].join('\n') }, { role: 'user', content: JSON.stringify(state.snapshot()) }],
  });
  return extractJson(response);
}

export async function decomposeQuery({ llm, state, signal, maxSubQuestions = 3 }) {
  try {
    const response = await llm.complete({
      purpose: 'gap_decomposition',
      signal,
      temperature: 0,
      messages: [{ role: 'system', content: [
        'Decompose the research question into 2-3 orthogonal sub-questions that together cover it.',
        'Each sub-question must be self-contained and searchable. If the question compares subjects, dedicate at least one sub-question to each subject.',
        'Return JSON only: {"subQuestions":["...","..."]}',
      ].join('\n') }, { role: 'user', content: state.query }],
    });
    const parsed = extractJson(response);
    if (!Array.isArray(parsed?.subQuestions)) return [];
    return parsed.subQuestions
      .map((question) => String(question || '').trim())
      .filter(Boolean)
      .slice(0, maxSubQuestions);
  } catch {
    return [];
  }
}

function readHostnames(state) {
  const hostnames = new Set();
  for (const id of state.readSourceIds) {
    const hostname = hostnameOf(state.candidates.get(id)?.url || id);
    if (hostname) hostnames.add(hostname);
  }
  return hostnames;
}

export function pickUnreadCandidates(state, count = 2) {
  const rankedUnread = state.rankedCandidates().filter((candidate) => !state.readSourceIds.has(candidate.id));
  if (!rankedUnread.length) return [];
  const alreadyRead = readHostnames(state);
  const picks = [];
  const seenHostnames = new Set();
  for (const candidate of rankedUnread) {
    const hostname = hostnameOf(candidate.url);
    if (hostname && (alreadyRead.has(hostname) || seenHostnames.has(hostname))) continue;
    if (hostname) seenHostnames.add(hostname);
    picks.push(candidate);
    if (picks.length >= count) break;
  }
  if (!picks.length) picks.push(rankedUnread[0]);
  return picks;
}

export function fallbackAdaptiveAction(state) {
  const picks = state.lastAction === 'read' ? [] : pickUnreadCandidates(state, 2);
  if (picks.length) {
    return { action: 'read', sourceIds: picks.map((candidate) => candidate.id), gapId: picks[0].gapId, reasonCode: 'fallback_read_evidence' };
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
