import crypto from 'node:crypto';
import { parseStructuredResponse } from '../structured-response.mjs';
import { createTimeoutSignal, isAbortError } from './semantic-provider-errors.mjs';

export const JEV_DEFAULT_MODEL = 'jev-1.13.0';
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
export const JEV_DEFAULT_MAX_STATE_CHARS = 160000;
export const JUDGE_QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

export const JUDGE_ERROR_CATEGORIES = Object.freeze({
  unavailable: 'unavailable',
  client: 'client',
  structure: 'structure',
});

const PROBABILITY_SUM_TOLERANCE = 0.01;

// Messages are fixed strings: provider bodies and request data never reach them.
export class JudgeProviderError extends Error {
  constructor(category, code, { status = null, provider = 'jev', cause } = {}) {
    super(`Judge provider ${category}: ${code}${status ? ` (HTTP ${status})` : ''}.`, cause ? { cause: { name: cause.name, code: cause.code } } : undefined);
    this.name = 'JudgeProviderError';
    this.category = category;
    this.code = category === JUDGE_ERROR_CATEGORIES.client ? 'JUDGE_CLIENT_ERROR' : code;
    this.reason = code;
    this.status = status;
    this.provider = provider;
  }
}

export function isJudgeUnavailable(error) {
  return error instanceof JudgeProviderError && error.category !== JUDGE_ERROR_CATEGORIES.client;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sliceCodeUnits(text, limit) {
  let end = Math.max(0, limit);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Bound the state by characters before sending. Objects are sent as their JSON
 * text once they no longer fit, so a truncated state is never a broken object.
 */
export function prepareJudgeState(state, maxChars = JEV_DEFAULT_MAX_STATE_CHARS) {
  const limit = Math.max(1, Math.floor(Number(maxChars) || JEV_DEFAULT_MAX_STATE_CHARS));
  if (Array.isArray(state)) {
    const items = state.map((item) => String(item ?? ''));
    const originalChars = items.reduce((sum, item) => sum + item.length, 0);
    if (originalChars <= limit) return { state: items, truncated: false, originalChars, sentChars: originalChars, sha256: sha256(items) };
    const kept = [];
    let used = 0;
    for (const item of items) {
      if (used >= limit) break;
      const part = item.length + used > limit ? sliceCodeUnits(item, limit - used) : item;
      if (part) kept.push(part);
      used += part.length;
    }
    return { state: kept, truncated: true, originalChars, sentChars: used, sha256: sha256(kept) };
  }
  if (state && typeof state === 'object') {
    const text = JSON.stringify(state);
    if (text.length <= limit) return { state, truncated: false, originalChars: text.length, sentChars: text.length, sha256: sha256(text) };
    const part = sliceCodeUnits(text, limit);
    return { state: part, truncated: true, originalChars: text.length, sentChars: part.length, sha256: sha256(part) };
  }
  const text = String(state ?? '');
  const part = text.length > limit ? sliceCodeUnits(text, limit) : text;
  return { state: part, truncated: part.length < text.length, originalChars: text.length, sentChars: part.length, sha256: sha256(part) };
}

export function validateJudgeQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) throw new TypeError('Judge questions must be an object keyed by id.');
  const entries = Object.entries(questions);
  if (!entries.length) throw new TypeError('Judge questions must not be empty.');
  for (const [id, question] of entries) {
    if (!id || !JUDGE_QUESTION_TYPES.includes(question?.type) || typeof question.instructions !== 'string' || !question.instructions.trim()) {
      throw new TypeError('Invalid judge question.');
    }
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria || {});
      if (!keys.length || keys.length > 255) throw new TypeError('Choice questions need 1-255 criteria.');
    }
    if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) {
      throw new TypeError('Score questions need 2-10 ordered levels.');
    }
  }
  return entries;
}

function validProbabilityMap(map, keys) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const actual = Object.keys(map);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(map, key))) return false;
  if (!actual.every((key) => isProbability(map[key]))) return false;
  const total = actual.reduce((sum, key) => sum + map[key], 0);
  return Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function validAnswer(question, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.type !== question.type) return false;
  if (question.type === 'noul') return isProbability(answer.noul);
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    return typeof answer.choice === 'string' && keys.includes(answer.choice)
      && validProbabilityMap(answer.probabilities, keys) && isProbability(answer.confidence);
  }
  const levels = Object.keys(answer.probabilities || {});
  const numeric = levels.map(Number);
  if (levels.length !== question.criteria.length || !numeric.every(Number.isInteger)) return false;
  if (!validProbabilityMap(answer.probabilities, levels) || !isProbability(answer.confidence)) return false;
  return typeof answer.score === 'number' && Number.isFinite(answer.score)
    && answer.score >= Math.min(...numeric) && answer.score <= Math.max(...numeric);
}

/**
 * Every requested id must receive exactly one answer of the requested type.
 * Missing, extra, mistyped or out-of-range answers are structural errors.
 */
export function validateJudgeAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const ids = Object.keys(questions);
  const returned = Object.keys(answers);
  if (returned.length !== ids.length || !ids.every((id) => Object.hasOwn(answers, id))) return false;
  return ids.every((id) => validAnswer(questions[id], answers[id]));
}

export function judgeUsage(raw) {
  const input = raw?.input_tokens;
  const output = raw?.output_tokens;
  const known = [input, output].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return known
    ? { known: true, inputTokens: input, outputTokens: output, tokens: input + output }
    : { known: false };
}

function statusError(status, provider) {
  if (status === 402 || status === 429 || status >= 500) {
    return new JudgeProviderError(JUDGE_ERROR_CATEGORIES.unavailable, status === 402 ? 'JUDGE_NO_BALANCE' : status === 429 ? 'JUDGE_RATE_LIMITED' : 'JUDGE_SERVER_ERROR', { status, provider });
  }
  return new JudgeProviderError(JUDGE_ERROR_CATEGORIES.client, 'JUDGE_REQUEST_REJECTED', { status, provider });
}

/** TypeSafe System One dialect. Other dialects would implement the same judge() contract. */
export class JevJudgeProvider {
  constructor(config = {}, { onRequest } = {}) {
    this.provider = 'jev';
    this.dialect = 'typesafe';
    this.model = config.model || JEV_DEFAULT_MODEL;
    this.baseUrl = String(config.baseUrl || JEV_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.timeoutMs = Math.max(1, Number(config.timeoutMs) || 30000);
    this.batchSize = Math.max(1, Math.floor(Number(config.batchSize) || 40));
    this.maxStateChars = Math.max(1, Math.floor(Number(config.maxStateChars) || JEV_DEFAULT_MAX_STATE_CHARS));
    this.onRequest = onRequest;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
  }

  prepareState(state) {
    return prepareJudgeState(state, this.maxStateChars);
  }

  async judge({ state, questions, signal, prepared = null } = {}) {
    validateJudgeQuestions(questions);
    if (!this.apiKey) throw new JudgeProviderError(JUDGE_ERROR_CATEGORIES.client, 'JUDGE_AUTH_REQUIRED', { provider: this.provider });
    signal?.throwIfAborted?.();
    const bounded = prepared || this.prepareState(state);
    const startedAt = Date.now();
    const timed = createTimeoutSignal(signal, this.timeoutMs);
    let data;
    try {
      this.onRequest?.({ operation: 'judge', questionCount: Object.keys(questions).length });
      const response = await this.fetch(`${this.baseUrl}/systemone`, {
        method: 'POST',
        signal: timed.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, state: bounded.state, questions }),
      });
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* the status alone classifies the failure */ }
        throw statusError(response.status, this.provider);
      }
      const text = await response.text();
      try { JSON.parse(text); } catch { throw new JudgeProviderError(JUDGE_ERROR_CATEGORIES.structure, 'JUDGE_RESPONSE_INVALID', { provider: this.provider }); }
      const parsed = parseStructuredResponse(text, { rootType: 'object' });
      if (!parsed.ok) throw new JudgeProviderError(JUDGE_ERROR_CATEGORIES.structure, 'JUDGE_RESPONSE_INVALID', { provider: this.provider });
      data = parsed.parsed;
    } catch (error) {
      if (error?.name === 'BudgetExceededError') throw error;
      if (isAbortError(error) && signal?.aborted) throw error;
      if (timed.timedOut()) throw new JudgeProviderError(JUDGE_ERROR_CATEGORIES.unavailable, 'JUDGE_TIMEOUT', { provider: this.provider });
      if (error instanceof JudgeProviderError) throw error;
      throw new JudgeProviderError(JUDGE_ERROR_CATEGORIES.unavailable, 'JUDGE_NETWORK_ERROR', { provider: this.provider, cause: error });
    } finally {
      timed.cleanup();
    }
    const usage = judgeUsage(data?.usage);
    // Thresholds are calibrated per model version, so a substituted model is a structural error.
    if (data?.model !== this.model || !validateJudgeAnswers(questions, data?.answers)) {
      const error = new JudgeProviderError(JUDGE_ERROR_CATEGORIES.structure, 'JUDGE_ANSWERS_INVALID', { provider: this.provider });
      error.usage = usage;
      throw error;
    }
    return {
      provider: this.provider,
      dialect: this.dialect,
      model: this.model,
      answers: data.answers,
      usage,
      durationMs: Date.now() - startedAt,
      degraded: false,
    };
  }
}
