// Controlled semantic outputs use only public protocol inputs. Expected truth
// stays in each test's closure; it is never sent to the production judge.
export function candidateResponse(input, choose = () => true) {
  return { checks: input.checks.map(check => {
    const material = input.materials.find(m => m.id === check.materialId), body = input.bodies.find(b => b.id === material.bodyId);
    return { id: check.id, candidates: choose(check, material) ? [{ unitId: material.locator.units[0].id, quote: body.text }] : [] };
  }) };
}
export function decisionResponse(input, choose = () => 'full_support') {
  return { checks: input.checks.map((check, i) => {
    const choice = choose(check, i), relation = typeof choice === 'string' ? choice : choice?.relation;
    const body = input.bodies.find(b => b.id === check.bodyId);
    return { id: check.id, coverage: relation === 'uncertain' ? 'uncertain' : 'complete',
      relations: ['full_support', 'partial_support', 'contradiction'].includes(relation) ? [{ relation,
        unitId: check.locator.units[0].id, quote: body.text, basis: relation === 'contradiction' ? 'direct_negation' : 'assertion' }] : [] };
  }) };
}
export function basisAuditResponse(input, choose = () => ({ valid: true, issue: 'none', omissions: 'none' })) {
  return { checks: input.checks.map(check => {
    const answer = choose(check);
    return { id: check.id, coverage: answer.coverage || 'complete', omissions: answer.omissions || 'none',
      anchors: check.decision.anchors.map(a => ({ id: a.id, valid: answer.valid, issue: answer.issue })) };
  }) };
}
export const bindingResponse = (input, status = 'faithful') => ({ bindings: input.bindings.map(b => ({ id: b.id, status })) });
// Legacy relation-audit tests still exercise their historical schema explicitly.
export function relationAuditResponse(input, choose = () => 'full_support') {
  return { relations: input.relations.map(item => {
    const choice = choose(item), relation = typeof choice === 'string' ? choice : choice.relation;
    const target = typeof choice === 'string' ? 'property' : choice.target || 'property';
    return { id: item.id, relation, object: 'same', version: 'same', conditions: 'compatible',
      claimTarget: target, evidenceTarget: target, coexistence: relation === 'contradiction' ? 'cannot_both_hold' : 'can_both_hold' };
  }) };
}
