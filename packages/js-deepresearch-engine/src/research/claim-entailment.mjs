import { createHash } from 'node:crypto';
import { extractJsonObject } from './report-narrative.mjs';
import { claimEntailmentPrompt } from './prompts.mjs';
import { buildClaimEvaluation, CLAIM_VERDICTS } from './claim-quality.mjs';

const ALLOWED_VERDICTS = new Set(CLAIM_VERDICTS);

function normalizeQuote(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function passageContainsQuote(passages = [], quote = '') {
  const needle = normalizeQuote(quote);
  if (needle.length < 12) return false;
  return passages.some((passage) => normalizeQuote(passage?.text).includes(needle));
}

export function shouldJudgeClaim(claim = {}, passages = []) {
  if (claim.kind !== 'key_claim') return false;
  if (!claim.citationKeys?.length) return false;
  const flags = claim.flags || claim.evaluation?.flags || [];
  if (flags.includes('uncited') || flags.includes('unresolved_citation')) return false;
  if (flags.includes('missing_direct_evidence') || flags.includes('snippet_only')) return false;
  if (['supported', 'unsupported', 'conflicting'].includes(claim.evaluation?.verdict)) return false;
  if (passages.length) return citedPassagesFor(claim, passages).length > 0;
  return (claim.citedSourceIds || []).length > 0 || (claim.evidence || []).some((item) => item?.passageId);
}

function citedPassagesFor(claim, passages = []) {
  const sourceIds = new Set(claim.citedSourceIds || []);
  if (!sourceIds.size) return [];
  return passages.filter((passage) => sourceIds.has(passage.sourceId));
}

export function applyEntailmentVerdict(claim, judgment, passages = []) {
  const verdict = String(judgment?.verdict || '').trim();
  const quote = String(judgment?.quote || '').trim();
  if (!ALLOWED_VERDICTS.has(verdict) || verdict === 'conflicting') return claim;
  if (!passageContainsQuote(passages, quote)) return claim;
  const next = {
    ...claim,
    evidence: [
      ...(claim.evidence || []),
      {
        sourceId: passages.find((passage) => normalizeQuote(passage.text).includes(normalizeQuote(quote)))?.sourceId,
        passageId: passages.find((passage) => normalizeQuote(passage.text).includes(normalizeQuote(quote)))?.id,
        verdict,
        score: verdict === 'supported' ? 0.8 : (verdict === 'partially_supported' ? 0.4 : 0),
        method: 'llm',
        quote,
      },
    ],
  };
  next.evaluation = buildClaimEvaluation(next, {
    method: 'llm',
    origin: 'runtime_llm',
  });
  return next;
}

export function entailmentCacheKey(claim, passages = []) {
  const fingerprints = (passages || [])
    .map((passage) => createHash('sha256').update(String(passage?.text || '')).digest('hex'))
    .sort()
    .join(',');
  return `${String(claim?.text || '').normalize('NFKC').trim()}\0${fingerprints}`;
}

export async function applyClaimEntailment(claims = [], {
  llm,
  passages = [],
  signal,
  mode = 'rules_then_llm',
  cache = null,
} = {}) {
  if (mode === 'rules' || !llm?.complete) return claims;
  const store = cache || new Map();
  const next = [];
  for (const claim of claims) {
    if (!shouldJudgeClaim(claim, passages)) {
      next.push(claim);
      continue;
    }
    const cited = citedPassagesFor(claim, passages);
    if (!cited.length) {
      next.push(claim);
      continue;
    }
    const key = entailmentCacheKey(claim, cited);
    if (store.has(key)) {
      next.push(applyEntailmentVerdict(claim, store.get(key), cited));
      continue;
    }
    try {
      const raw = await llm.complete({
        purpose: 'claim_entailment',
        signal,
        temperature: 0,
        maxTokens: 400,
        messages: claimEntailmentPrompt({ claim, passages: cited }),
      });
      const judgment = extractJsonObject(raw);
      store.set(key, judgment);
      next.push(applyEntailmentVerdict(claim, judgment, cited));
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      next.push(claim);
    }
  }
  return next;
}
