import { createHash } from 'node:crypto';
import { judgeMaySend } from './judge-settings.mjs';

export const JUDGE_READ_PRIORITY_PURPOSE = 'judge_read_priority';

const FACET_WEIGHT = 0.8;

function gapFacets(gap) {
  const facets = (gap?.slotSupport?.missingFacets || []).map((item) => String(item || '').trim()).filter(Boolean);
  return facets.length ? [...new Set(facets)] : [String(gap?.question || '').trim()].filter(Boolean);
}

function cacheKey(judge, candidateId, gap, facets) {
  return createHash('sha256').update(JSON.stringify([judge.identityKey, candidateId, gap.id, [...facets].sort()])).digest('hex');
}

function batches(items, perItem, size) {
  const count = Math.max(1, Math.floor(size / perItem));
  const out = [];
  for (let index = 0; index < items.length; index += count) out.push(items.slice(index, index + count));
  return out;
}

/**
 * Scores unread candidates against the facts a gap still misses. The score is
 * only a scheduler sort key: candidates are never dropped and hard admission
 * rules are applied later, when the read actually happens.
 */
export async function judgeReadPriorities(judge, { gap, candidates = [], cache = new Map(), signal } = {}) {
  const priorities = new Map();
  const trace = { requests: 0, degraded: 0, cached: 0, skippedLocal: 0, errorCodes: [] };
  if (!judge?.enabled?.('readPriority') || !gap || !candidates.length) return { priorities, trace };
  const facets = gapFacets(gap).slice(0, Math.max(1, judge.batchSize - 1));
  if (!facets.length) return { priorities, trace };
  const pending = [];
  for (const candidate of candidates) {
    const id = candidate.id || candidate.url;
    if (!judgeMaySend(judge, candidate.url)) { trace.skippedLocal += 1; continue; }
    const key = cacheKey(judge, id, gap, facets);
    if (cache.has(key)) { priorities.set(id, cache.get(key)); trace.cached += 1; continue; }
    pending.push({ id, key, candidate });
  }
  for (const group of batches(pending, facets.length + 1, judge.batchSize)) {
    const questions = {};
    const refs = group.map((item, index) => {
      const ref = `c${index}`;
      facets.forEach((facet, facetIndex) => {
        questions[`${ref}_f${facetIndex}`] = { type: 'noul', instructions: `Is search result \`${ref}\` in \`candidates\` likely to contain facts that answer: ${facet}` };
      });
      questions[`${ref}_first_party`] = { type: 'noul', instructions: `Is search result \`${ref}\` in \`candidates\` published by the entity that \`question\` is about?` };
      return ref;
    });
    const result = await judge.judge({
      purpose: JUDGE_READ_PRIORITY_PURPOSE,
      signal,
      state: {
        question: gap.question || '',
        candidates: group.map((item, index) => ({ ref: refs[index], title: item.candidate.title || '', url: item.candidate.url || '', snippet: item.candidate.snippet || '' })),
      },
      questions,
    });
    if (result.status !== 'completed') {
      trace.degraded += 1;
      if (result.errorCode) trace.errorCodes.push(result.errorCode);
      continue;
    }
    if (!result.cached) trace.requests += 1;
    group.forEach((item, index) => {
      const facetMean = facets.reduce((sum, _, facetIndex) => sum + result.answers[`${refs[index]}_f${facetIndex}`].noul, 0) / facets.length;
      const firstParty = result.answers[`${refs[index]}_first_party`].noul;
      const readPriority = Math.round((FACET_WEIGHT * facetMean + (1 - FACET_WEIGHT) * firstParty) * 1e6) / 1e6;
      cache.set(item.key, readPriority);
      priorities.set(item.id, readPriority);
    });
  }
  return { priorities, trace };
}
