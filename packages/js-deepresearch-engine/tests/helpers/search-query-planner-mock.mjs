import { queryMatchesGapScope } from '../../src/research/adaptive/source-policy.mjs';

function norm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hintUsable(query, user = {}) {
  const gap = user.gap || (user.gaps || [])[0] || {};
  if (user.evidenceScope === 'local' && /\bsite:\s*\S+/i.test(query)) return false;
  if ((gap.question || gap.id) && !queryMatchesGapScope(query, gap, user.brief?.entities || [], [user.query])) {
    return false;
  }
  return true;
}

function uniqueGaps(user = {}) {
  const gaps = [];
  if (user.gap?.question || user.gap?.id) gaps.push(user.gap);
  if (Array.isArray(user.gaps)) {
    for (const gap of user.gaps) {
      if (gap && !gaps.some((item) => item.id && item.id === gap.id)) gaps.push(gap);
    }
  }
  const slots = user.brief?.slots || [];
  if (gaps.length) return gaps;
  if (slots.length) return slots.map((slot) => ({ id: slot.id, question: slot.question }));
  return [{ question: user.query, id: user.targetGapId }];
}

function plannedItem(query, user, item = {}) {
  return {
    query,
    targetGapId: item.id || user.gap?.id || user.targetGapId || null,
    intent: user.mode || 'search',
    expectedEvidence: 'source body',
    sourceType: user.evidenceScope === 'local' ? 'local' : 'web',
  };
}

function nextAngle(base, mode, searched) {
  const suffix = {
    repair: 'latest official documents',
    recovery: 'additional official documents',
    challenge: 'limitations and criticism',
    angle_change: 'alternative sources',
    site_fallback: 'public documents',
  }[mode] || 'follow-up research';
  const angled = `${base} ${suffix}`.trim();
  if (angled && !searched.has(norm(angled))) return angled;
  return `${base} follow-up research`.trim();
}

export function defaultSearchQueryPlan(messages = []) {
  const userRaw = messages.find((item) => item.role === 'user')?.content || '{}';
  let user = {};
  try { user = JSON.parse(userRaw); } catch { user = {}; }
  const searched = new Set([
    ...(user.searchedQueries || []),
    ...(user.exhaustedAngles || []),
    ...(user.rejectedQueries || []).map((item) => item.query || item),
  ].map(norm).filter(Boolean));
  const sources = uniqueGaps(user);
  const hints = (user.hints || []).map((item) => String(item || '').trim()).filter(Boolean);
  const unusedHints = hints.filter((item) => !searched.has(norm(item)));
  const usableHints = unusedHints.filter((item) => hintUsable(item, user));
  const limit = Number(user.limit) || Math.max(sources.length, usableHints.length, 1);

  if (user.mode === 'site_fallback') {
    const raw = String(user.siteFallbackFor || unusedHints[0] || sources[0]?.question || user.query || 'topic fallback');
    const stripped = raw.replace(/\bsite:\S+/gi, '').trim();
    const query = stripped && !searched.has(norm(stripped))
      ? stripped
      : nextAngle(sources[0]?.question || user.query || 'topic', 'site_fallback', searched);
    return JSON.stringify({ queries: [plannedItem(query, user, sources[0])] });
  }

  if (usableHints.length) {
    return JSON.stringify({
      queries: usableHints.slice(0, limit).map((query) => plannedItem(query, user, sources[0])),
    });
  }
  if (hints.length && unusedHints.length === 0) {
    return JSON.stringify({ queries: [] });
  }

  const queries = sources.slice(0, limit).map((item) => {
    const base = String(item.question || user.query || 'research topic').trim();
    const query = base && !searched.has(norm(base)) ? base : nextAngle(base, user.mode, searched);
    return plannedItem(query, user, item);
  }).filter((item) => item.query);
  return JSON.stringify({ queries });
}

export function withSearchQueryPlanner(complete) {
  return async (args) => {
    if (args.purpose === 'search_query_planning') return defaultSearchQueryPlan(args.messages);
    return complete(args);
  };
}
