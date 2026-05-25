export const DEFAULT_SKILL_PROFILE = Object.freeze({
  driver: 'unified',
  command: 'search',
  limitFlag: '--limit',
  serverFlag: '--server',
  supportsMaxPages: true,
  supportsQuiet: true,
  supportsTimeoutMs: true,
  extraArgs: {},
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
