export const DEFAULT_SKILL_PROFILE = Object.freeze({
  driver: 'unified',
  command: 'search',
  limitFlag: '--limit',
  serverFlag: '--server',
  supportsMaxPages: true,
  supportsQuiet: true,
  supportsTimeoutMs: true,
  extraArgs: {},
  supportedSearchOptions: [],
  fixedEngine: null,
});

export const JS_EYES_SKILL_PROFILES = Object.freeze({
  'js-x-ops-skill': Object.freeze({
    driver: 'skill-run',
    preCommand: 'navigate-search',
    command: 'search',
    limitFlag: '--max-tweets',
    serverFlag: '--ws-endpoint',
    supportsMaxPages: true,
    supportsQuiet: false,
    supportsTimeoutMs: false,
    extraArgs: {},
    platform: 'x',
    supportedSearchOptions: [],
    fixedEngine: 'js-eyes:x',
  }),
  'js-reddit-ops-skill': Object.freeze({
    driver: 'skill-run',
    command: 'search',
    limitFlag: '--limit',
    serverFlag: '--ws-endpoint',
    supportsMaxPages: false,
    supportsQuiet: false,
    supportsTimeoutMs: false,
    extraArgs: { 'read-mode': 'api' },
    platform: 'reddit',
    supportedSearchOptions: [],
    fixedEngine: 'js-eyes:reddit',
  }),
  'js-zhihu-ops-skill': Object.freeze({
    driver: 'skill-run',
    command: 'search',
    limitFlag: '--limit',
    serverFlag: '--ws-endpoint',
    supportsMaxPages: true,
    supportsQuiet: true,
    supportsTimeoutMs: false,
    extraArgs: {},
    platform: 'zhihu',
    supportedSearchOptions: [],
    fixedEngine: 'js-eyes:zhihu',
  }),
  'js-google-ops-skill': Object.freeze({
    driver: 'skill-run',
    command: 'search',
    limitFlag: '--limit',
    serverFlag: '--server',
    supportsMaxPages: true,
    supportsQuiet: false,
    supportsTimeoutMs: false,
    extraArgs: {},
    platform: 'google',
    supportedSearchOptions: [],
    fixedEngine: 'js-eyes:google',
  }),
});

export function getSkillProfile(skillId) {
  return {
    ...DEFAULT_SKILL_PROFILE,
    ...(JS_EYES_SKILL_PROFILES[skillId] || {}),
  };
}

export function inferPlatform(skillId, profile = getSkillProfile(skillId)) {
  if (profile.platform) return profile.platform;
  const value = String(skillId || '').toLowerCase();
  if (value.includes('x-ops') || value === 'js-x-ops-skill') return 'x';
  if (value.includes('zhihu')) return 'zhihu';
  if (value.includes('xiaohongshu') || value.includes('xhs')) return 'xhs';
  if (value.includes('reddit')) return 'reddit';
  if (value.includes('google')) return 'google';
  return value || 'unknown';
}

export function resolveDriverMode(provider, skills) {
  const mode = String(provider?.driver || 'auto').toLowerCase();
  if (mode === 'unified') return 'unified';
  if (mode === 'skill-run') return 'skill-run';

  for (const skillId of skills) {
    if (getSkillProfile(skillId).driver === 'skill-run') {
      return 'skill-run';
    }
  }
  return 'unified';
}

export function resolveJsEyesCapabilities(provider = {}, extra = {}) {
  const skills = Array.isArray(provider.skills) ? provider.skills : [];
  const profiles = skills.length ? skills.map((skillId) => getSkillProfile(skillId)) : [DEFAULT_SKILL_PROFILE];
  const optionSets = profiles.map((profile) => new Set(profile.supportedSearchOptions || []));
  const supported = optionSets.length
    ? [...optionSets[0]].filter((key) => optionSets.every((set) => set.has(key)))
    : [];
  const engines = [...new Set(profiles.map((profile) => profile.fixedEngine).filter(Boolean))];
  return {
    maxQuestionConcurrency: 1,
    supportedSearchOptions: supported,
    fixedEngine: engines.length === 1 ? engines[0] : null,
    ...extra,
  };
}
