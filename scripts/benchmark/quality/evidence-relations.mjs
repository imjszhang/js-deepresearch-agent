import { evidenceCatalog, resolveLocator } from './locators.mjs';
import { invariant, span } from './schema.mjs';

export const RELATIONS = ['full_support', 'partial_support', 'contradiction', 'not_addressed', 'uncertain'];
export function validateRelationAnchor(anchor, evidence, candidates = []) {
  const source = evidence.find(e => e.id === anchor.id);
  invariant(source && typeof source.text === 'string', 'Invalid relation source');
  const located = resolveLocator(anchor, evidenceCatalog(source), candidates);
  invariant(span(source.text, located.span) === located.quote, 'Invalid relation anchor');
  Object.assign(anchor, located);
  invariant(['full_support', 'partial_support', 'contradiction'].includes(anchor.relation), 'Invalid anchor relation');
  invariant(anchor.object === 'same' && ['same', 'not_applicable'].includes(anchor.version)
    && anchor.conditions === 'compatible', 'Evidence object/version/conditions do not align');
}
export function relationTruth(check, evidence, candidates = []) {
  invariant(RELATIONS.includes(check.relation) && Array.isArray(check.evidence), 'Invalid evidence relation');
  for (const anchor of check.evidence) validateRelationAnchor(anchor, evidence, candidates);
  const relations = new Set(check.evidence.map(e => e.relation));
  if (check.relation === 'uncertain' || relations.has('contradiction') && (relations.has('full_support') || relations.has('partial_support'))) return 'pending_review';
  if (check.relation === 'not_addressed') {
    invariant(check.evidence.length === 0, 'Unaddressed claim with positive or negative evidence');
    return 'unverifiable';
  }
  invariant(relations.has(check.relation), 'Relation without direct anchor');
  invariant(check.relation !== 'partial_support' || !relations.has('contradiction'), 'Partial support with decisive counterevidence');
  return { full_support: 'correct', partial_support: 'partial', contradiction: 'incorrect' }[check.relation];
}

// Mapping is a semantic check, comparison is deterministic. Unknown/missing
// fields cannot become evidence for a numeric mismatch (especially null vs 0).
export function operationalTruth(check, fields) {
  invariant(['exact', 'uncertain'].includes(check.mapping), 'Invalid field mapping');
  if (check.mapping === 'uncertain') return 'pending_review';
  const field = fields.find(f => f.id === check.fieldId);
  invariant(field && Object.hasOwn(check, 'assertedValue') && ['string', 'number', 'boolean'].includes(typeof check.assertedValue), 'Invalid execution field');
  if (field.state === 'missing') return 'unverifiable';
  if (field.state !== 'known') return 'pending_review';
  if (field.field === 'floorStatus' && field.value === 'unknown' && check.assertedValue !== 'unknown') return 'pending_review';
  invariant(typeof field.value === typeof check.assertedValue, 'Ambiguous execution value type');
  return field.value === check.assertedValue ? 'correct' : 'incorrect';
}
