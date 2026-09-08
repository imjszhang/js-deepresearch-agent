import { createHash } from 'node:crypto';
import { passageContainsQuote } from './claim-entailment.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export function buildClaimGraph({ gaps = [], passages = [], priorRegistry = null } = {}) {
  const records = new Map();
  const bindings = [];
  const entries = globalThis.structuredClone(priorRegistry?.entries || []);
  function cite(passage) {
    let entry = entries.find((item) => item.documentVersionId === passage.documentVersionId && item.passageIds.includes(passage.id));
    if (!entry) {
      const existingDocument = entries.find((item) => item.documentVersionId === passage.documentVersionId);
      if (existingDocument) { existingDocument.passageIds.push(passage.id); return existingDocument.citationKey; }
      entry = { citationKey: `${entries.length + 1}.1`, sourceId: passage.sourceId,
        documentVersionId: passage.documentVersionId, passageIds: [passage.id], url: passage.url };
      entries.push(entry);
    }
    return entry.citationKey;
  }
  function make(proposition, kind, support, extra = {}) {
    const supportRefs = support.map((passage) => ({ passageId: passage.id, documentVersionId: passage.documentVersionId, sourceId: passage.sourceId }));
    const claimId = `claim-${hash([proposition, kind, supportRefs])}`;
    if (!records.has(claimId)) records.set(claimId, { claimId, revision: 1, kind, proposition, supportRefs, counterRefs: [],
      citationKeys: [...new Set(support.map(cite))], conditions: [], evaluation: { verdict: 'unverifiable', method: 'pending' }, ...extra });
    // A premise may also directly answer a separate required question.
    if (extra.premiseOnly !== true) records.get(claimId).premiseOnly = false;
    return records.get(claimId);
  }
  for (const gap of gaps.filter((item) => !item.rollup)) {
    const support = gap.slotSupport;
    const refs = passages.filter((passage) => passage.documentVersionId && (
      (support?.supportingPassageIds || []).includes(passage.id)
      || (passage.findingIds?.length && passageContainsQuote([passage], support?.quote)
        && (support?.evidenceSourceIds || []).includes(passage.sourceId))));
    if (!support?.quoteAnchored || !refs.length || !passageContainsQuote(refs, support.quote)) {
      bindings.push({ taskId: gap.id, claimId: null, adequacy: 'missing', missingFacets: support?.missingFacets || [gap.question], required: Boolean(gap.requiredSlot) });
      continue;
    }
    const isDerived = ['derived_judgment', 'comparison'].includes(gap.taskType) && Boolean(support.answer);
    let record;
    if (isDerived) {
      const premises = refs.map((passage) => make(passage.text, 'source_attributed', [passage], { premiseOnly: true }));
      record = make(support.answer, 'derived', refs, { premiseClaimIds: premises.map((item) => item.claimId),
        inference: support.answer, assumptions: [], uncertainty: support.verdict === 'supported' ? null : 'partial_premises' });
    } else {
      record = make(support.answer || support.quote, 'source_attributed', refs);
    }
    record.counterRefs = [...new Map([...record.counterRefs, ...passages.filter((passage) => passage.documentVersionId && (support.contradictingPassageIds || []).includes(passage.id))
      .map((passage) => ({ passageId: passage.id, documentVersionId: passage.documentVersionId, sourceId: passage.sourceId }))].map((ref) => [ref.passageId, ref])).values()];
    bindings.push({ taskId: gap.id, claimId: record.claimId,
      adequacy: gap.status === 'verified' && support.verdict === 'supported' ? 'verified' : 'partial',
      missingFacets: support.missingFacets || [], required: Boolean(gap.requiredSlot) });
  }
  // Unbound observations stay in EvidenceStore. A document's presence is not an
  // obligation to publish a claim about it, nor permission to bypass task review.
  return { schemaVersion: 1, records: [...records.values()], bindings, citationRegistry: { schemaVersion: 1, entries } };
}

export function validateClaimGraph(graph, evidenceStore) {
  const records = new Map(graph.records.map((record) => [record.claimId, record]));
  const visiting = new Set(), visited = new Set();
  function visit(record) {
    if (visited.has(record.claimId)) return;
    if (visiting.has(record.claimId)) throw new Error('Circular claim premises.');
    visiting.add(record.claimId);
    for (const ref of [...record.supportRefs, ...record.counterRefs]) {
      const passage = evidenceStore.passages.get(ref.passageId);
      if (!passage || passage.documentVersionId !== ref.documentVersionId || passage.sourceId !== ref.sourceId
        || evidenceStore.body(ref.documentVersionId).slice(passage.startChar, passage.endChar) !== passage.text) throw new Error('Invalid claim anchor.');
    }
    for (const premiseId of record.premiseClaimIds || []) {
      if (!records.has(premiseId)) throw new Error('Missing claim premise.');
      visit(records.get(premiseId));
    }
    visiting.delete(record.claimId); visited.add(record.claimId);
  }
  graph.records.forEach(visit);
  return true;
}

export function propagateClaimVerdicts(graph) {
  const byId = new Map(graph.records.map((record) => [record.claimId, record]));
  let changed;
  do {
    changed = false;
    for (const record of graph.records) {
      if (record.kind === 'derived' && record.evaluation.verdict === 'supported'
        && record.premiseClaimIds.some((key) => byId.get(key)?.evaluation.verdict !== 'supported')) {
        record.evaluation = { verdict: 'unverifiable', method: 'premise_dependency' }; changed = true;
      }
    }
  } while (changed);
  for (const binding of graph.bindings) {
    const record = byId.get(binding.claimId);
    if (!record || record.evaluation.verdict !== 'supported') binding.adequacy = 'limited';
    else if (binding.missingFacets?.length && binding.adequacy === 'verified') binding.adequacy = 'partial';
  }
}
