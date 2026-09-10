import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadNamedCheckpoint, sanitizeRecordedValue } from './run-recorder.mjs';
import { resolveReportSettings } from './report-settings.mjs';

const sections = {
  llm: ['provider', 'model', 'baseUrl', 'temperature', 'maxTokens', 'timeoutMs', 'reasoningEffort'],
  search: ['engine', 'baseUrl', 'maxResults', 'language', 'safeSearch', 'options', 'provider', 'local',
    'jsEyesCli', 'jsEyesSkill', 'jsEyesSkills', 'jsEyesServerUrl', 'jsEyesTimeoutMs', 'jsEyesCommand'],
  http: ['proxy', 'http2', 'cookieRetry', 'userAgent', 'acceptLanguage', 'referer', 'hostHeaders', 'maxRedirects', 'maxResponseBytes', 'allowedContentTypes'],
  research: ['strategy', 'iterations', 'questionsPerIteration', 'concurrency', 'reportValidation', 'report',
    'quality', 'budget', 'providers', 'read', 'focused', 'exploratory'],
};
const secret = /api.?key|password|secret|authorization|cookie$|credential|token(?!s)/i;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function publicValue(value, key = '') {
  if (secret.test(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => publicValue(item)).filter(item => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(k => [k, publicValue(value[k], k)]).filter(([, v]) => v !== undefined));
  return sanitizeRecordedValue(value, key);
}
function merge(base, overlay) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(overlay || {})) out[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? merge(base?.[key], value) : globalThis.structuredClone(value);
  return out;
}
function error(code, fields = []) {
  const value = new Error(`${code}${fields.length ? `: ${fields.join(', ')}` : ''}`);
  value.code = code; value.fields = fields; return value;
}
function bind(original, saved, target) {
  for (const [key, value] of Object.entries(original || {})) {
    if (secret.test(key)) target[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key]) bind(value, saved?.[key], target[key]);
    else if (typeof value === 'string' && /url|endpoint|proxy/i.test(key) && publicValue(value, key) === saved?.[key]) target[key] = value;
  }
}

export function validateReportBudget(settings) {
  if (Number(settings?.research?.budget?.maxTotalLlmTokens) > 0 && !(resolveReportSettings(settings).maxOutputTokens > 0)) {
    throw error('INVALID_REPORT_BUDGET_CONFIGURATION', ['research.report.maxOutputTokens']);
  }
}
export function createRunExecutionConfig(settings) {
  validateReportBudget(settings);
  const selected = Object.fromEntries(Object.entries(sections).map(([section, keys]) => [section,
    Object.fromEntries(keys.filter(key => settings?.[section]?.[key] !== undefined).map(key => [key, settings[section][key]]))]));
  selected.research.report = { ...selected.research.report, maxOutputTokens: resolveReportSettings(settings).maxOutputTokens };
  const value = publicValue(selected);
  return { schemaVersion: 1, settings: value, configHash: hash(value) };
}
export function validateRunExecutionConfig(config) {
  if (config?.schemaVersion !== 1 || hash(config.settings) !== config.configHash) throw error('RUN_CONFIG_INTEGRITY');
  return config;
}

export function resolveRunExecutionSettings(settings, { sessionDir, checkpoint } = {}) {
  const start = sessionDir ? loadNamedCheckpoint(sessionDir, 'research-start')?.state : null;
  const runFile = sessionDir && path.join(sessionDir, 'run.json');
  const manifest = runFile && fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : {};
  const frozen = checkpoint?.executionConfig || start?.executionConfig || manifest.executionConfig;
  if (frozen) {
    validateRunExecutionConfig(frozen);
    const current = publicValue(settings);
    const identityPaths = [['llm', 'provider'], ['llm', 'model'], ['llm', 'baseUrl'], ['search', 'engine'], ['search', 'baseUrl']];
    const changed = identityPaths.filter(([a, b]) => frozen.settings[a]?.[b] != null && current[a]?.[b] != null
      && frozen.settings[a][b] !== current[a][b]).map(parts => parts.join('.'));
    for (const key of ['skills', 'serverUrl', 'driver']) if (frozen.settings.search?.provider?.[key] != null
      && current.search?.provider?.[key] != null && JSON.stringify(frozen.settings.search.provider[key]) !== JSON.stringify(current.search.provider[key])) changed.push(`search.provider.${key}`);
    if (changed.length) throw error('RESUME_CONFIG_IDENTITY_MISMATCH', changed);
    const resolved = merge(settings, frozen.settings);
    // Restore secret-bearing connection values only when their public identity matches.
    bind(settings, frozen.settings, resolved);
    validateReportBudget(resolved);
    return { settings: resolved, config: frozen, provenance: 'frozen_config' };
  }
  // Legacy snapshots have no config contract. Recover only recorded fields; never
  // infer a report cap from today's default when its old budget already records it.
  const recorded = manifest.settings || {};
  const identityPaths = [['llm', 'provider'], ['llm', 'model'], ['llm', 'baseUrl'], ['search', 'engine']];
  const unresolved = identityPaths.filter(([a, b]) => settings[a]?.[b] && !recorded[a]?.[b]);
  if (unresolved.length) throw error('RESUME_CONFIG_UNRESOLVED', unresolved.map(p => p.join('.')));
  const changed = identityPaths.filter(([a, b]) => settings[a]?.[b] && recorded[a]?.[b]
    && publicValue(settings[a][b], b) !== publicValue(recorded[a][b], b));
  if (changed.length) throw error('RESUME_CONFIG_IDENTITY_MISMATCH', changed.map(p => p.join('.')));
  const restored = merge(settings, publicValue(recorded));
  const budget = checkpoint?.budget || start?.budget;
  const cap = Number(budget?.maxReportOutputTokens);
  if (cap > 0) restored.research = merge(restored.research, { report: { maxOutputTokens: cap } });
  if (Number(budget?.limits?.totalLlmTokens) > 0) restored.research = merge(restored.research, { budget: { maxTotalLlmTokens: budget.limits.totalLlmTokens } });
  // Legacy snapshots also need live authentication on matching endpoint URLs.
  bind(settings, publicValue(recorded), restored);
  const config = createRunExecutionConfig(restored);
  return { settings: restored, config, unresolvedFields: unresolved.map(p => p.join('.')),
    provenance: unresolved.length ? 'legacy_identity_unresolved' : cap > 0 ? 'legacy_budget_and_manifest' : 'legacy_manifest' };
}
