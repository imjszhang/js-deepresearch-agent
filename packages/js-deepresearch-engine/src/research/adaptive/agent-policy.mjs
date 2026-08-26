import { hostnameOf } from './research-state.mjs';
import { isOrthogonalGap } from './exploratory-sufficiency.mjs';

const ACTION_SCHEMA = '{"action":"search|read|reflect|answer|stop","reasonCode":"short_code","gapId":"gap-1","query":"...","queries":["..."],"sourceIds":["..."],"gapQuestion":"..."}';

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

export async function decideAdaptiveAction({ llm, state, signal }) {
  const snapshot = state.snapshot();
  const belowMin = Boolean(snapshot.budget?.belowMin);
  const response = await llm.complete({
    purpose: 'agent_decision',
    signal,
    temperature: 0,
    maxTokens: 600,
    messages: [{ role: 'system', content: [
      'You are a budget-aware research agent. Choose exactly one next action.',
      'Token budget has a floor and a ceiling. The floor is a minimum explore spend, not a stop target.',
      'While budget.belowMin is true, keep exploring: search or read missing subjects and open gaps. Do not answer yet.',
      'After budget.minReached, answer when sufficiency.sufficient is true or body evidence covers every critical gap.',
      'budget.hardCapLlmTokens / remainingVsHardCap is the hard ceiling. Reserve report tokens and do not exceed it.',
      'Prefer high evidence-per-token actions. Do not pad tokens after the floor if evidence is already sufficient.',
      'Candidate "score" values are optional observations, never mandatory source choices.',
      'Top-ranked sources are harvested automatically after each search; that harvest is not a decision step.',
      'Use read only to pick additional unread sources the auto-harvest skipped. Consecutive reads of different unread sources are allowed.',
      'Use reflect only when you have a genuinely new orthogonal gap that is not a paraphrase of an existing gap.',
      'Prefer working on focusGapId unless another open gap is clearly more urgent.',
      'Do not repeat the exact previous action with no new information (same search query, or reflect without a new gap).',
      'Never answer immediately after a search unless body-level evidence was already harvested.',
      'A search action may include up to 3 distinct queries in "queries"; make them complementary, not paraphrases.',
      'A read action should include 2-4 sourceIds when several promising unread candidates exist.',
      'Never repeat or closely paraphrase a query listed in searchedQueries; propose a genuinely different query instead.',
      'If the research question compares multiple subjects, ensure searches and reads cover each subject; check knowledge for subjects with no dedicated evidence yet.',
      'Use knowledge, gap coverage, and sufficiency to judge whether collected evidence already answers the open gaps.',
      belowMin ? 'You are still below the token floor. Do not answer. Explore another unread source or uncovered subject.' : '',
      'Budget fields: usedLlmTokens, minLlmTokens, remainingVsMin, remainingVsHardCap, reservedReportTokens (prompt+completion reserved for the final report), and actionCostEstimates.',
      `Return JSON only: ${ACTION_SCHEMA}`,
    ].filter(Boolean).join('\n') }, { role: 'user', content: JSON.stringify(snapshot) }],
  });
  return extractJson(response);
}

export async function decomposeQuery({ llm, state, signal, maxSubQuestions = 3 }) {
  try {
    const response = await llm.complete({
      purpose: 'gap_decomposition',
      signal,
      temperature: 0,
      maxTokens: 400,
      messages: [{ role: 'system', content: [
        'Decompose the research question into 2-3 orthogonal sub-questions that together cover it.',
        'Each sub-question must be self-contained and searchable. If the question compares subjects, dedicate at least one sub-question to each subject.',
        'Do not paraphrase the original question. Skip decomposition for simple definitional questions.',
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

export function fallbackAdaptiveAction(state, options = {}) {
  const sufficiency = options.sufficiency || state.sufficiency;
  const belowMin = Boolean(options.belowMin);
  if (sufficiency?.sufficient && !belowMin) {
    return { action: 'answer', reasonCode: 'fallback_evidence_sufficient' };
  }
  const picks = pickUnreadCandidates(state, 2);
  if (picks.length) {
    return {
      action: 'read',
      sourceIds: picks.map((candidate) => candidate.id),
      gapId: picks[0].gapId,
      reasonCode: 'fallback_read_evidence',
    };
  }
  const searchedOriginal = state.searchedQueries().includes(state.query);
  if ((state.candidates.size === 0 || !searchedOriginal) && state.lastAction !== 'search') {
    return { action: 'search', query: state.query, gapId: 'gap-1', reasonCode: 'fallback_initial_search' };
  }
  if (belowMin) {
    const uncovered = (state.gaps || []).find((gap) => (
      !state.gapCovered(gap.id) && !state.searchedQueries().includes(gap.question)
    ));
    if (uncovered) {
      return {
        action: 'search',
        query: uncovered.question,
        gapId: uncovered.id,
        reasonCode: 'fallback_explore_below_min',
      };
    }
    return { action: 'answer', reasonCode: 'fallback_exploration_exhausted' };
  }
  return { action: 'answer', reasonCode: 'fallback_evidence_available' };
}

export function canReflectNewGap(state, gapQuestion) {
  return isOrthogonalGap(state.gaps, gapQuestion);
}

export async function evaluateAnswerReadiness({ llm, state, signal }) {
  try {
    const response = await llm.complete({
      purpose: 'answer_evaluation',
      signal,
      temperature: 0,
      maxTokens: 400,
      messages: [{ role: 'system', content: [
        'You review whether collected research knowledge is sufficient to definitively answer the question.',
        'Fail only when a clearly important aspect of the question has no supporting knowledge at all.',
        'Return JSON only: {"pass":true|false,"missingAspect":"one concrete unanswered sub-question or empty string"}',
      ].join('\n') }, { role: 'user', content: JSON.stringify({
        query: state.query,
        gaps: state.gaps,
        knowledge: state.knowledge,
        findingsCount: state.findings.length,
        sufficiency: state.sufficiency,
      }) }],
    });
    const parsed = extractJson(response);
    if (!parsed || typeof parsed.pass !== 'boolean') return null;
    return { pass: parsed.pass, missingAspect: String(parsed.missingAspect || '').trim() };
  } catch {
    return null;
  }
}
