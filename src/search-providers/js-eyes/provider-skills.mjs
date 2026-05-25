export const DEFAULT_JS_EYES_SKILL = 'js-zhihu-ops-skill';

export function parseProviderSkills(value, fallback = DEFAULT_JS_EYES_SKILL) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;\s]+/);

  const skills = [];
  const seen = new Set();

  for (const entry of rawValues) {
    const skill = String(entry || '').trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }

  return skills.length ? skills : [fallback];
}

/** @deprecated use parseProviderSkills */
export const parseJsEyesSkills = parseProviderSkills;
