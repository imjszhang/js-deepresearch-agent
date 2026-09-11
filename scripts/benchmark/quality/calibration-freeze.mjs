import { RELATION_DECISION_VERSION } from './relation-decision.mjs';
import { BINDING_REVIEW_VERSION } from './assertion-bindings.mjs';
import { RELATION_REVIEW_VERSION } from './relation-components.mjs';
import { RELATION_AUDIT_VERSION } from './relation-audit.mjs';
import { REQUEST_BUDGET_VERSION } from './request-budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hash, invariant, readJson } from './schema.mjs';
import { LOCATOR_VERSION } from './locators.mjs';
import { EXECUTION_METRICS_VERSION } from './execution-metrics.mjs';
export function verificationFiles() {
  const files = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file); else if (e.isFile()) files.push({ file, hash: hash(fs.readFileSync(file)) });
  } };
  for (const dir of ['scripts/benchmark/quality', 'packages/js-deepresearch-engine/src', 'src', 'tests']) walk(dir);
  for (const file of ['scripts/benchmark-quality.mjs', 'package.json', 'package-lock.json']) files.push({ file, hash: hash(fs.readFileSync(file)) });
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
export function verificationIdentity() { return hash(verificationFiles()); }
export function freezeVerification(planFile, validationFile, codeIdentity) {
  invariant(planFile && validationFile, 'Calibration requires plan-file and validation-file before first call');
  const validation = readJson(validationFile), files = verificationFiles();
  invariant(validation.codeIdentity === codeIdentity && validation.verificationIdentity === hash(files)
    && ['test', 'lint', 'build', 'diffCheck'].every(k => validation.checks?.[k]?.passed === true), 'Calibration offline validation changed or incomplete');
  return { planFile: path.resolve(planFile), planHash: hash(fs.readFileSync(planFile)), validationFile: path.resolve(validationFile),
    validationHash: hash(validation), files, relationReviewVersion: RELATION_REVIEW_VERSION, relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION, relationAuditVersion: RELATION_AUDIT_VERSION, requestBudgetVersion: REQUEST_BUDGET_VERSION, locatorVersion: LOCATOR_VERSION, executionMetricsVersion: EXECUTION_METRICS_VERSION };
}
export function validateFrozenVerification(freeze) {
  const expected = freezeVerification(freeze.planFile, freeze.validationFile, freeze.codeIdentity);
  invariant(Object.entries(expected).every(([k, v]) => hash(freeze[k]) === hash(v)), 'Calibration gate: verification identity changed');
}
