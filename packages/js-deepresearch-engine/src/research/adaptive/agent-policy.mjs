import { hostnameOf } from './research-state.mjs';
import { isOrthogonalGap } from './exploratory-sufficiency.mjs';
import { nextUnusedSearchAngles, nextUnusedSiteQueries, shortSearchTerms } from './source-policy.mjs';

const ACTION_SCHEMA = '{"action":"search|read|reflect|draft|finalize","reasonCode":"short_code","gapId":"gap-1","query":"...","queries":["..."],"sourceIds":["..."],"gapQuestion":"..."}';

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function normalizeDecision(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.action === 'answer') parsed.action = 'finalize';
  if (parsed.action === 'stop') parsed.action = 'finalize';
  return parsed;
}

export async function decideAdaptiveAction({ llm, state, signal }) {
  const snapshot = state.snapshot();
  const belowMin = Boolean(snapshot.budget?.belowMin);
  const gatePass = Boolean(snapshot.readiness?.pass);
  const response = await llm.complete({
    purpose: 'agent_decision',
    signal,
    temperature: 0,
    maxTokens: 600,
    messages: [{ role: 'system', content: [
      'You are a budget-aware research agent. Choose exactly one next action.',
      'Actions: search, read, reflect, draft, finalize. "answer" is an alias for finalize.',
      'Token budget has a floor and a ceiling. The floor is a minimum explore spend, not a stop target.',
      'While budget.belowMin is true, keep exploring: search or read missing subjects and open gaps. Do not finalize yet.',
      'readiness.pass is the only evidence-sufficient signal. You cannot override a failed readiness gate.',
      'After a search, you must read a real body before draft/finalize. Snippets, WAF, and shell pages do not count.',
      'If a gap lists requiredHosts, those are commitments from the research profile. You may use site:host queries for them. Do not invent exchange, regulator, or annual-report hosts.',
      'Use read to pick unread sources for the current focus gap. Consecutive reads of different unread sources are allowed.',
      'Use reflect only when you have a genuinely new orthogonal gap that is not a paraphrase of an existing gap.',
      'Use draft for a candidate answer that will be checked; failed drafts become repair gaps.',
      'Use finalize only when readiness.pass is true and you are not below the token floor.',
      'If budget.belowMin is false but readiness.pass is false, do not finalize. Keep searching or reading unread sources that address the failed gate.',
      'Never repeat or closely paraphrase a query listed in searchedQueries.',
      'A search action may include up to 3 distinct queries in "queries"; make them complementary, not paraphrases.',
      'A read action should include 2-4 sourceIds when several promising unread candidates exist.',
      belowMin ? 'You are still below the token floor. Do not finalize. Explore another unread source or uncovered subject.' : '',
      !belowMin && !gatePass ? 'The token floor is already met but readiness.pass is false. Do not finalize. Search or read for the missing commitment, not a default filing venue.' : '',
      gatePass ? 'The deterministic readiness gate currently passes.' : 'The deterministic readiness gate currently fails; keep searching or reading.',
      'Budget fields: usedLlmTokens, minLlmTokens, remainingVsMin, remainingVsHardCap, and actionCostEstimates.',
      `Return JSON only: ${ACTION_SCHEMA}`,
    ].filter(Boolean).join('\n') }, { role: 'user', content: JSON.stringify(snapshot) }],
  });
  return normalizeDecision(extractJson(response));
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

export function pickUnreadCandidates(state, count = 2, gapId = null) {
  if (typeof state.pickPolicyReads === 'function') {
    return state.pickPolicyReads(count, gapId);
  }
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

export function belowHardCapFrom(state, options = {}) {
  if (options.belowHardCap !== undefined) return Boolean(options.belowHardCap);
  if (state?.budgetView?.hardCapReached) return false;
  const remaining = state?.budgetView?.remainingVsHardCap;
  if (remaining == null) return true;
  return remaining > 0;
}

export function buildAngleChangeSearch(state, { reasonCode = 'fallback_angle_change' } = {}) {
  const focus = (typeof state.focusGap === 'function' ? state.focusGap() : null) || state.gaps?.[0];
  const searched = typeof state.searchedQueries === 'function' ? state.searchedQueries() : [];
  const siteQueries = nextUnusedSiteQueries(focus, state.query, searched, { limit: 3 });
  const angles = siteQueries.length
    ? siteQueries
    : nextUnusedSearchAngles(state.query || focus?.question || '', searched, { limit: 3 });
  const short = shortSearchTerms(state.query || focus?.question || '');
  const step = Number(state.step) || 0;
  const query = angles[0] || `${short} ${step + 1}`.trim();
  return {
    action: 'search',
    query,
    queries: angles.length ? angles : undefined,
    gapId: focus?.id || 'gap-1',
    reasonCode,
  };
}

export function fallbackAdaptiveAction(state, options = {}) {
  const readiness = options.readiness || state.readiness;
  const sufficiency = options.sufficiency || state.sufficiency;
  const belowMin = Boolean(options.belowMin);
  const belowHardCap = belowHardCapFrom(state, options);
  const gatePass = readiness ? Boolean(readiness.pass) : Boolean(sufficiency?.sufficient);
  if (gatePass && !belowMin) {
    return { action: 'answer', reasonCode: 'fallback_evidence_sufficient' };
  }
  const focusId = state.focusGap?.()?.id || 'gap-1';
  const picks = pickUnreadCandidates(state, 2, focusId);
  if (picks.length) {
    return {
      action: 'read',
      sourceIds: picks.map((candidate) => candidate.id),
      gapId: picks[0].gapId || focusId,
      reasonCode: 'fallback_read_evidence',
    };
  }
  const searchedOriginal = state.searchedQueries().includes(state.query);
  if ((state.candidates.size === 0 || !searchedOriginal) && state.lastAction !== 'search') {
    return { action: 'search', query: state.query, gapId: 'gap-1', reasonCode: 'fallback_initial_search' };
  }
  const uncovered = (state.gaps || []).find((gap) => (
    !state.gapCovered(gap.id) && !state.searchedQueries().includes(gap.question)
  ));
  if (uncovered && state.lastAction !== 'search') {
    const siteQueries = nextUnusedSiteQueries(uncovered, state.query, state.searchedQueries(), { limit: 3 });
    const angles = siteQueries.length
      ? siteQueries
      : nextUnusedSearchAngles(uncovered.question || state.query, state.searchedQueries(), { limit: 3 });
    return {
      action: 'search',
      query: angles[0] || shortSearchTerms(uncovered.question || state.query),
      queries: angles.length ? angles : undefined,
      gapId: uncovered.id,
      reasonCode: belowMin ? 'fallback_explore_below_min' : 'fallback_search_open_gap',
    };
  }
  if (!gatePass && !belowHardCap) {
    return { action: 'answer', reasonCode: 'budget_exhausted' };
  }
  return buildAngleChangeSearch(state, {
    reasonCode: belowMin ? 'fallback_explore_below_min' : 'fallback_angle_change',
  });
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
        'You review missing evidence. You cannot mark the research sufficient when the deterministic gate failed.',
        'Propose one concrete repair sub-question when something important is missing.',
        'Return JSON only: {"pass":true|false,"missingAspect":"one concrete unanswered sub-question or empty string"}',
      ].join('\n') }, { role: 'user', content: JSON.stringify({
        query: state.query,
        gaps: state.gaps,
        knowledge: state.knowledge,
        findingsCount: state.findings.length,
        readiness: state.readiness,
        sufficiency: state.sufficiency,
      }) }],
    });
    const parsed = extractJson(response);
    if (!parsed || typeof parsed.pass !== 'boolean') return null;
    const gatePass = Boolean(state.readiness?.pass);
    return {
      pass: parsed.pass && gatePass,
      llmPass: parsed.pass,
      missingAspect: String(parsed.missingAspect || '').trim(),
    };
  } catch {
    return null;
  }
}
