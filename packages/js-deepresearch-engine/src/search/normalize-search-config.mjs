import { parseJsEyesSkills } from './engines/js-eyes.mjs';

export function normalizeSearchConfig(config = {}) {
  const options = {
    ...(config.options && typeof config.options === 'object' ? config.options : {}),
  };

  const legacy = {
    jsEyesCli: config.jsEyesCli,
    jsEyesSkill: config.jsEyesSkill,
    jsEyesSkills: config.jsEyesSkills,
    jsEyesCommand: config.jsEyesCommand,
    jsEyesServerUrl: config.jsEyesServerUrl,
    jsEyesMaxPages: config.jsEyesMaxPages,
    jsEyesTimeoutMs: config.jsEyesTimeoutMs,
    jsEyesArgs: config.jsEyesArgs,
  };

  for (const [key, value] of Object.entries(legacy)) {
    if (value !== undefined && value !== null && value !== '' && options[key] === undefined) {
      options[key] = value;
    }
  }

  const merged = {
    ...config,
    options,
  };

  for (const [key, value] of Object.entries(legacy)) {
    if (options[key] !== undefined) {
      merged[key] = options[key];
    }
  }

  if (options.jsEyesSkill && !options.jsEyesSkills) {
    options.jsEyesSkills = parseJsEyesSkills(options.jsEyesSkill);
    merged.jsEyesSkills = options.jsEyesSkills;
  }

  return merged;
}
