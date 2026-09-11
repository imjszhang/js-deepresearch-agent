import { hash, invariant } from './schema.mjs';

export const VERIFICATION_CONTRACT_VERSION = 1;
export const VERIFICATION_ORIGINS = ['model_assessment', 'scripted_fixture', 'program_check', 'program_oracle', 'human_review'];
const ownedFields = new Set(['origin', 'programVerification', 'artifactVerification', 'programChecks', 'programProof',
  'humanReview', 'humanReviewed', 'humanVerified', 'programVerified', 'bindingIntegrity', 'verification', 'assurance']);

// The source is selected by the caller/provider adapter, never from a response.
export function assessmentOrigin(source) {
  return source === 'scripted_fixture' || source?.assessmentOrigin === 'scripted_fixture' ? 'scripted_fixture' : 'model_assessment';
}
export function aggregateAssessmentOrigin(values, fallback = 'model_assessment') {
  const origins = values.flat(Infinity).filter(Boolean).map(value => typeof value === 'string' ? value : value.origin);
  return origins.includes('scripted_fixture') || fallback === 'scripted_fixture' ? 'scripted_fixture' : 'model_assessment';
}
export function modelAssessment(value, source) {
  const origin = assessmentOrigin(source);
  const clean = item => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !ownedFields.has(key)).map(([key, child]) => [key, clean(child)]));
  };
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Assessment record required');
  return { ...clean(value), origin };
}

// Only code-owned predicates enter this constructor. It never evaluates prose
// or upgrades a model observation into a program oracle or human review.
export function programCheck(checks, { scope = 'declared_structure', dependencies = {} } = {}) {
  invariant(checks && typeof checks === 'object' && !Array.isArray(checks)
    && Object.values(checks).every(value => value === true || value === false || value === null), 'Invalid program predicates');
  const values = Object.values(checks);
  return { verificationVersion: VERIFICATION_CONTRACT_VERSION, origin: 'program_check', scope,
    status: values.some(value => value === false) ? 'failed' : !values.length || values.some(value => value === null) ? 'incomplete' : 'passed',
    checks: { ...checks }, dependencyHash: hash(dependencies) };
}
