import { hostnameOf } from './hostname-policy.mjs';
import { isOrthogonalGap } from './exploratory-sufficiency.mjs';
import { selectReads, requiredHostQueries } from './source-policy.mjs';

const ACTION_SCHEMA = '{"action":"search|read|reflect|draft|finalize","reasonCode":"short_code","gapId":"gap-1","query":"...","queries":["..."],"sourceIds":["..."],"gapQuestion":"..."}';

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

export function normalizeAgentAction(action) {
  if (!action || typeof action !== 'object') return action;
  if (action.action === 'answer') return { ...action, action: 'finalize' };
  if (action.action === 'stop') return { ...action, action: 'finalize', forced: true };
  return action;
}

export async function decideAdaptiveAction({ llm, state, signal }) {
  const snapshot = state.snapshot();
  const belowMin = Boolean(snapshot.budget?.belowMin);
  const gatePass = Boolean(snapshot.readiness?.pass || snapshot.sufficiency?.sufficient);
  const response = await llm.complete({
    purpose: 'agent_decision',
    signal,
    temperature: 0,
    maxTokens: 600,
    messages: [{ role: 'system', content: [
      'You are a budget-aware research agent. Choose exactly one next action.',
      'Allowed actions: search, read, reflect, draft, finalize. "answer" is treated as finalize.',
      'Token budget has a floor and a ceiling. The floor is a minimum explore spend, not a stop target.',
      'While budget.belowMin is true, keep exploring: search or read missing subjects and open gaps. Do not finalize yet.',
      'evidence_sufficient is a hard deterministic gate. You cannot declare it if readiness.pass is false.',
      'After search, you must read a real body before draft or finalize. Snippets, WAF pages, and failed fetches do not count.',
      'Prefer requiredHosts and primary tiers over media reprints. Do not treat reprints as verification for required-primary gaps.',
      'If a gap lists requiredHosts, search with site:host queries before concluding the source is blocked.',
      'Use reflect only when you have a genuinely new orthogonal gap that is not a paraphrase of an existing gap.',
      'Prefer working on focusGapId unless another open required gap is more urgent.',
      'Never repeat the exact previous action with no new information (same search query, or reflect without a new gap).',
      'Never finalize immediately after a search unless a successful body was already read in that cycle.',
      'A search action may include up to 3 distinct queries in "queries"; make them complementary, not paraphrases.',
      'A read action should include 2-4 sourceIds when several promising unread candidates exist.',
      'Never repeat or closely paraphrase a query listed in searchedQueries; propose a genuinely different query instead.',
      'Use draft to propose a candidate answer for the gate. If the previous draft failed, do not resubmit the same answer; open a repair gap instead.',
      'finalize only when readiness.pass is true and you are not below the token floor.',
      belowMin ? 'You are still below the token floor. Do not finalize. Explore another unread source or uncovered subject.' : '',
      gatePass ? 'The deterministic gate currently passes. You may finalize after the token floor.' : 'The deterministic gate currently fails. Do not finalize as evidence_sufficient.',
      'Budget fields: usedLlmTokens, minLlmTokens, remainingVsMin, remainingVsHardCap, and actionCostEstimates.',
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

export function pickUnreadCandidates(state, count = 2, gap = null) {
  const focus = gap || state.focusGap?.() || state.gaps?.[0];
  const selected = selectReads({
    candidates: [...state.candidates.values()],
    gap: focus,
    readSourceIds: state.readSourceIds,
    failedIds: state.failedSourceIds || new Set(),
    count,
    maxPerHostname: 2,
  });
  if (selected.length) return selected;
  const rankedUnread = (state.rankedCandidates?.() || []).filter((candidate) => !state.readSourceIds.has(candidate.id));
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
  const readiness = options.readiness || state.readiness || sufficiency?.readiness;
  const belowMin = Boolean(options.belowMin);
  const gatePass = Boolean(readiness?.pass ?? sufficiency?.sufficient);
  if (gatePass && !belowMin) {
    return { action: 'answer', reasonCode: 'fallback_evidence_sufficient' };
  }
  const focus = state.focusGap?.() || state.gaps?.[0];
  const siteQueries = requiredHostQueries(focus, { alreadySearched: state.searchedQueries?.() || [] });
  const picks = pickUnreadCandidates(state, 2, focus);
  if (picks.length) {
    return {
      action: 'read',
      sourceIds: picks.map((candidate) => candidate.id),
      gapId: picks[0].gapId || focus?.id,
      reasonCode: 'fallback_read_evidence',
    };
  }
  if (siteQueries.length && state.lastAction !== 'search') {
    return {
      action: 'search',
      query: siteQueries[0],
      queries: siteQueries.slice(0, 3),
      gapId: focus?.id || 'gap-1',
      reasonCode: 'fallback_required_host_search',
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
      const hostQueries = requiredHostQueries(uncovered, { alreadySearched: state.searchedQueries() });
      return {
        action: 'search',
        query: hostQueries[0] || uncovered.question,
        gapId: uncovered.id,
        reasonCode: 'fallback_explore_below_min',
      };
    }
    return { action: 'answer', reasonCode: 'fallback_exploration_exhausted' };
  }
  if (readiness?.blockedRequired || (focus?.requiredHosts || []).length) {
    return { action: 'answer', reasonCode: 'source_blocked' };
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
        'You may identify missing aspects and propose a repair gap. You cannot override a failed deterministic readiness gate.',
        'Fail only when a clearly important aspect of the question has no supporting knowledge at all.',
        'Return JSON only: {"pass":true|false,"missingAspect":"one concrete unanswered sub-question or empty string"}',
      ].join('\n') }, { role: 'user', content: JSON.stringify({
        query: state.query,
        gaps: state.gaps,
        knowledge: state.knowledge,
        findingsCount: state.findings.length,
        sufficiency: state.sufficiency,
        readiness: state.readiness,
      }) }],
    });
    const parsed = extractJson(response);
    if (!parsed || typeof parsed.pass !== 'boolean') return null;
    return { pass: parsed.pass, missingAspect: String(parsed.missingAspect || '').trim() };
  } catch {
    return null;
  }
}
