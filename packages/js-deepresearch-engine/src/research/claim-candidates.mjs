import { createHash } from 'node:crypto';
import { passageContainsQuote } from './claim-entailment.mjs';

export const CLAIM_GRAPH_VERSION = 2;
export const VALIDATION_PROTOCOL_VERSION = 4;
const id = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

// Candidate extraction proves only literal anchoring, never truth or adequacy.
// Each candidate must still pass the shared claim and answer-relation review.
export function normalizeClaimCandidates(raw, passages, depth = 0) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20 || depth > 1) throw new Error('Invalid atomic candidates');
  return raw.map(item => {
    if (!item || typeof item.proposition !== 'string' || !item.proposition.trim()
      || !['source_attributed', 'derived'].includes(item.kind)
      || !Array.isArray(item.conditions) || item.conditions.some(x => typeof x !== 'string')
      || !Array.isArray(item.supportingPassageIds) || !item.supportingPassageIds.length
      || new Set(item.supportingPassageIds).size !== item.supportingPassageIds.length) throw new Error('Invalid atomic candidate');
    const support = item.supportingPassageIds.map(key => passages.find(p => p.id === key));
    if (support.some(p => !p?.documentVersionId) || !passageContainsQuote(support, item.quote)) throw new Error('Unanchored atomic candidate');
    const premises = item.kind === 'derived' ? normalizeClaimCandidates(item.premises, passages, depth + 1) : [];
    if (item.kind === 'derived' && (!premises.length || premises.some(p => p.kind !== 'source_attributed'))) throw new Error('Invalid atomic premises');
    const value = { proposition: item.proposition.trim(), kind: item.kind, conditions: item.conditions,
      entity: typeof item.entity === 'string' ? item.entity : null, version: typeof item.version === 'string' ? item.version : null,
      quote: item.quote, supportingPassageIds: item.supportingPassageIds, premises };
    return { ...value, candidateId: 'candidate-' + id(value), extractionProtocolVersion: VALIDATION_PROTOCOL_VERSION };
  });
}
