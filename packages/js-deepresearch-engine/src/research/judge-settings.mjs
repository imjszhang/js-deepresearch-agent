import { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MAX_STATE_CHARS, JEV_DEFAULT_MODEL } from './providers/jev-judge-provider.mjs';

export const JUDGE_PROVIDERS = Object.freeze(['disabled', 'jev']);
export const JUDGE_FEATURES = Object.freeze(['sourceAssessment', 'readPriority', 'queryScreening', 'passageOrder']);

export const DEFAULT_JUDGE_THRESHOLDS = Object.freeze({
  assessmentConfidence: 0.8,
  unreadable: 0.9,
  firstParty: 0.8,
  duplicateIntent: 0.9,
});

export const DEFAULT_JUDGE_SETTINGS = Object.freeze({
  provider: 'disabled',
  model: JEV_DEFAULT_MODEL,
  baseUrl: JEV_DEFAULT_BASE_URL,
  apiKey: '',
  timeoutMs: 30000,
  batchSize: 40,
  maxStateChars: JEV_DEFAULT_MAX_STATE_CHARS,
  allowLocalCorpus: false,
  features: Object.freeze(Object.fromEntries(JUDGE_FEATURES.map((feature) => [feature, false]))),
  thresholds: DEFAULT_JUDGE_THRESHOLDS,
});

function probability(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

export function resolveJudgeSettings(raw = {}) {
  const provider = String(raw?.provider || 'disabled');
  if (!JUDGE_PROVIDERS.includes(provider)) throw new Error(`Unsupported judge provider: ${provider}`);
  const features = Object.fromEntries(JUDGE_FEATURES.map((feature) => [feature, raw?.features?.[feature] === true]));
  const thresholds = Object.fromEntries(Object.entries(DEFAULT_JUDGE_THRESHOLDS)
    .map(([key, fallback]) => [key, probability(raw?.thresholds?.[key], fallback)]));
  return {
    ...DEFAULT_JUDGE_SETTINGS,
    ...(raw || {}),
    provider,
    model: String(raw?.model || JEV_DEFAULT_MODEL),
    allowLocalCorpus: raw?.allowLocalCorpus === true,
    features,
    thresholds,
  };
}

export function judgeActive(raw = {}) {
  const settings = resolveJudgeSettings(raw);
  return settings.provider !== 'disabled' && JUDGE_FEATURES.some((feature) => settings.features[feature]);
}

/** Local corpus text stays on this machine unless the judge was explicitly allowed to see it. */
export function judgeMaySend(judge, url) {
  if (!judge) return false;
  return judge.allowLocalCorpus === true || !/^file:/i.test(String(url || '').trim());
}
