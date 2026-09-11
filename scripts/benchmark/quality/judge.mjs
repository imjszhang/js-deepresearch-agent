import { RELATION_DECISION_VERSION } from './relation-decision.mjs';
import { BINDING_REVIEW_VERSION } from './assertion-bindings.mjs';
import { evaluatorMessages, conservativeRequestReservation, REQUEST_BUDGET_VERSION } from './request-budget.mjs';
import { RELATION_REVIEW_VERSION } from './relation-components.mjs';
import { RELATION_AUDIT_VERSION } from './relation-audit.mjs';
import { LOCATOR_VERSION } from './locators.mjs';
import { EXECUTION_METRICS_VERSION } from './execution-metrics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hash, readJson, writeJson, invariant, JUDGE_VERSION, ExactIdSetError } from './schema.mjs';

export function parseJson(text) {
  const cleaned = cleanStructuredText(text);
  return JSON.parse(cleaned);
}
function cleanStructuredText(text) {
  return String(text || '').trim().replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
    .replace(/^<\/think>\s*/i, '').replace(/\s*<\/think>$/i, '')
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
}
const answerFields = {
  extract: new Set(['blocks', 'id', 'classification', 'facts', 'quote', 'unitId', 'fragmentId', 'catalogHash', 'owner', 'contextLocators', 'span', 'contextSpans', 'proposition', 'kind', 'citationKeys', 'replaces']),
  review_relations: new Set(['reviews', 'checks', 'id', 'status', 'relations', 'relation', 'unitId', 'fragmentId', 'quote', 'catalogHash', 'span', 'start', 'end', 'contextSpans']),
  verify_execution: new Set(['reviews', 'id', 'mapping', 'fieldId', 'assertedValue']),
  audit_relations: new Set(['relations', 'id', 'relation', 'object', 'version', 'conditions', 'claimTarget', 'evidenceTarget', 'coexistence']),
  audit_extraction: new Set(['blocks', 'id', 'checks', 'status', 'factIds']),
  verify_facts: new Set(['facts', 'id', 'relation', 'evidence', 'quote', 'unitId', 'fragmentId', 'catalogHash', 'owner', 'contextLocators', 'span', 'object', 'version', 'conditions', 'citations', 'key', 'verdict', 'passageIds', 'mapping', 'fieldId', 'assertedValue']),
  match_criteria: new Set(['criteria', 'id', 'answer', 'factIds', 'qualifiers', 'met', 'missingMinor', 'conflict']),
  diagnose: new Set(['diagnoses', 'id', 'failures', 'stage', 'contextIds', 'claimIds', 'confidence']),
};
answerFields.find_evidence = new Set(['checks', 'id', 'candidates', 'unitId', 'fragmentId', 'quote', 'catalogHash', 'span', 'start', 'end', 'contextSpans']);
answerFields.decide_relations = new Set(['checks', 'id', 'coverage', 'relations', 'relation', 'unitId', 'fragmentId', 'quote', 'basis', 'catalogHash', 'span', 'start', 'end']);
answerFields.repair_relation_decisions = answerFields.decide_relations;
answerFields.audit_relation_decisions = new Set(['checks', 'id', 'coverage', 'anchors', 'valid', 'issue', 'omissions']);
answerFields.audit_relation_decisions_final = answerFields.audit_relation_decisions;
answerFields.audit_bindings = new Set(['bindings', 'id', 'status']);
answerFields.audit_bindings_final = answerFields.audit_bindings;
answerFields.repair_bindings = new Set(['bindings', 'id', 'contextLocators', 'unitId', 'fragmentId', 'quote', 'catalogHash', 'span', 'start', 'end']);
answerFields.extract_repair = answerFields.extract;
answerFields.audit_extraction_final = answerFields.audit_extraction;
function safeAnswer(value, purpose) {
  if (Array.isArray(value)) return value.map(v => safeAnswer(v, purpose));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => answerFields[purpose] ? answerFields[purpose].has(key)
    : !/^(reasoning|analysis|thoughts|chain_of_thought|rationale|explanation|apiKey|authorization)$/i.test(key))
    .map(([key, child]) => [key, safeAnswer(child, purpose)]));
}

// Reservations survive ambiguous requests. Responses are written before parsing;
// retries reuse settled response files and never silently repay the same call.
export class Judge {
  constructor({ llm, directory, limit = 100000, identity, assessmentOrigin = 'model_assessment', timeoutMs = 180000, wallClockMs = 1800000, stages = null, beforeDispatch = () => {} }) {
    this.beforeDispatch = beforeDispatch; this.llm = llm; this.directory = directory; this.limit = limit; this.identity = identity;
    this.assessmentOrigin = assessmentOrigin === 'scripted_fixture' ? 'scripted_fixture' : 'model_assessment';
    this.timeoutMs = timeoutMs;
    this.wallClockMs = wallClockMs;
    this.stages = stages; this.stage = null; this.supportsDispatch = true;
    fs.mkdirSync(directory, { recursive: true });
    this.ledgerFile = path.join(directory, 'ledger.json');
    this.ledger = fs.existsSync(this.ledgerFile) ? readJson(this.ledgerFile) : { schemaVersion: 1, calls: {} };
    const policyHash = hash({ relationReviewVersion: RELATION_REVIEW_VERSION, relationDecisionVersion: RELATION_DECISION_VERSION, bindingReviewVersion: BINDING_REVIEW_VERSION, relationAuditVersion: RELATION_AUDIT_VERSION, requestBudgetVersion: REQUEST_BUDGET_VERSION, judgeVersion: JUDGE_VERSION, locatorVersion: LOCATOR_VERSION, executionMetricsVersion: EXECUTION_METRICS_VERSION, identity, assessmentOrigin: this.assessmentOrigin, limit, timeoutMs, wallClockMs, stages });
    invariant(!this.ledger.policyHash || this.ledger.policyHash === policyHash, 'JUDGE_POLICY_CHANGED');
    this.ledger.policyHash = policyHash;
    for (const [id, call] of Object.entries(this.ledger.calls)) {
      const file = path.join(directory, `${id}.json`);
      if (!fs.existsSync(file)) continue;
      const response = readJson(file), tokens = response.usage?.totalTokens;
      Object.assign(call, { tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : null, status: 'responded',
        activeMs: response.activeMs ?? call.activeMs ?? timeoutMs });
    }
    writeJson(this.ledgerFile, this.ledger);
  }
  setStage(stage) { invariant(this.stages?.[stage], 'Unknown judge stage'); this.stage = stage; }
  usage(stage = null) {
    const entries = Object.values(this.ledger.calls).filter(c => stage == null || c.stage === stage);
    return { confirmedTokens: entries.reduce((n, c) => n + (c.tokens ?? 0), 0),
      reservedUnknownTokens: entries.filter(c => c.tokens == null).reduce((n, c) => n + c.reserved, 0),
      unknownCalls: entries.filter(c => c.tokens == null).length, calls: entries.length, limit: this.limit,
      activeMs: entries.reduce((n, c) => n + (c.activeMs ?? Math.min(this.timeoutMs, Math.max(0, Date.now() - Date.parse(c.createdAt)))), 0), wallClockMs: this.wallClockMs };
  }
  async ask(purpose, instructions, input, validate, maxTokens = 4500, { maxAttempts = 2, onDispatch = () => {} } = {}) {
    const baseMessages = evaluatorMessages(instructions, input);
    let feedback = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const messages = feedback ? [...baseMessages, { role: 'user', content: JSON.stringify({ structureCorrection: feedback,
        instruction: 'Return the required JSON with all exact IDs and only permitted labels. Do not repeat the invalid structure. For criteria forbidding partial credit, missing decisive details score incorrect or missing, never partial.' }) }] : baseMessages;
      const id = hash({ version: JUDGE_VERSION, identity: this.identity, stage: this.stage, purpose, messages, maxTokens, attempt });
      const responseFile = path.join(this.directory, `${id}.json`);
      let response;
      if (fs.existsSync(responseFile)) {
        response = readJson(responseFile);
      } else {
        invariant(!this.ledger.calls[id], 'JUDGE_OUTCOME_UNKNOWN: resolve the recorded attempt before retrying');
        invariant(!Object.values(this.ledger.calls).some(c => c.tokens == null), 'JUDGE_OUTCOME_UNKNOWN: unresolved usage blocks new dispatch');
        const reserved = conservativeRequestReservation(messages, maxTokens);
        const usage = this.usage();
        invariant(usage.confirmedTokens + usage.reservedUnknownTokens + reserved <= this.limit, 'JUDGE_BUDGET_EXCEEDED');
        invariant(usage.activeMs < this.wallClockMs, 'JUDGE_WALL_CLOCK_EXCEEDED');
        let remainingMs = this.wallClockMs - usage.activeMs;
        if (this.stages) {
          invariant(this.stage && this.stages[this.stage], 'JUDGE_STAGE_REQUIRED');
          const stageUsage = this.usage(this.stage), cap = this.stages[this.stage];
          invariant(stageUsage.confirmedTokens + stageUsage.reservedUnknownTokens + reserved <= cap.tokens, 'JUDGE_STAGE_BUDGET_EXCEEDED');
          invariant(stageUsage.activeMs < cap.wallClockMs, 'JUDGE_STAGE_WALL_CLOCK_EXCEEDED');
          remainingMs = Math.min(remainingMs, cap.wallClockMs - stageUsage.activeMs);
        }
        this.beforeDispatch();
        const started = Date.now();
        onDispatch(id);
        this.ledger.calls[id] = { purpose, stage: this.stage, reserved, tokens: null, status: 'started', createdAt: new Date().toISOString() };
        writeJson(this.ledgerFile, this.ledger);
        try {
          const raw = await this.llm.completeWithMetadata({ messages, temperature: 0, maxTokens, purpose: 'benchmark_judge', signal: globalThis.AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, remainingMs))) });
          const cleaned = cleanStructuredText(raw.text);
          // Persist structured answers only, never free-form reasoning or provider errors.
          let structured = null;
          try { structured = JSON.parse(cleaned); } catch { /* counted as a parse failure below */ }
          response = { text: structured ? JSON.stringify(safeAnswer(structured, purpose)) : '', outputHash: hash(raw.text || ''), usage: raw.usage || null, activeMs: Date.now() - started };
          writeJson(responseFile, response);
        } catch {
          Object.assign(this.ledger.calls[id], { status: 'outcome_unknown', activeMs: Date.now() - started }); writeJson(this.ledgerFile, this.ledger);
          throw new Error('JUDGE_PROVIDER_FAILED: reserved usage retained');
        }
      }
      const tokens = response.usage?.totalTokens;
      invariant(this.ledger.calls[id], 'Judge response without ledger');
      Object.assign(this.ledger.calls[id], { tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : null, status: 'responded',
        activeMs: response.activeMs ?? this.ledger.calls[id].activeMs ?? this.timeoutMs });
      writeJson(this.ledgerFile, this.ledger);
      try { const parsed = parseJson(response.text); validate(parsed); return parsed; } catch (error) {
        feedback = /Partial credit/.test(error.message) ? 'partial_credit_forbidden'
          : /Truth without checked evidence/.test(error.message) ? 'correct_requires_checked_evidence_otherwise_use_unverifiable'
          : /exact/.test(error.message) ? 'id_set_invalid' : error instanceof SyntaxError ? 'invalid_json' : 'schema_invalid';
        this.ledger.calls[id].validationFailure = feedback;
        if (error instanceof ExactIdSetError) {
          feedback = { code: error.code, ...error.details };
          this.ledger.calls[id].validationDetails = feedback;
        }
        writeJson(this.ledgerFile, this.ledger);
        if (attempt === maxAttempts - 1) throw Object.assign(new Error('JUDGE_STRUCTURE_INVALID', { cause: error }),
          error instanceof ExactIdSetError ? { code: error.code, details: error.details } : {});
      }
    }
  }
}
