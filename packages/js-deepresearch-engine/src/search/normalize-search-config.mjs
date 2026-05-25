import { parseProviderSkills } from './provider-skills.mjs';

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function buildProviderFromLegacy(config, options) {
  const skills = parseProviderSkills(
    config.jsEyesSkills ?? options.jsEyesSkills ?? config.jsEyesSkill ?? options.jsEyesSkill,
  );

  return {
    cli: config.jsEyesCli ?? options.jsEyesCli ?? 'js-eyes',
    driver: config.jsEyesCommand === 'skill-run' ? 'skill-run' : 'auto',
    serverUrl: config.jsEyesServerUrl ?? options.jsEyesServerUrl ?? '',
    timeoutMs: positiveInteger(
      config.jsEyesTimeoutMs ?? options.jsEyesTimeoutMs,
      120000,
    ),
    maxPages: positiveInteger(
      config.jsEyesMaxPages ?? options.jsEyesMaxPages,
      1,
    ),
    skills,
    args: {
      ...(options.jsEyesArgs && typeof options.jsEyesArgs === 'object' ? options.jsEyesArgs : {}),
      ...(config.jsEyesArgs && typeof config.jsEyesArgs === 'object' ? config.jsEyesArgs : {}),
    },
  };
}

function mergeProvider(existing = {}, legacy = {}, explicit = {}) {
  const skills = parseProviderSkills(
    explicit.skills ?? legacy.skills ?? existing.skills,
  );

  return {
    cli: explicit.cli ?? legacy.cli ?? existing.cli ?? 'js-eyes',
    driver: explicit.driver ?? legacy.driver ?? existing.driver ?? 'auto',
    serverUrl: explicit.serverUrl ?? legacy.serverUrl ?? existing.serverUrl ?? '',
    timeoutMs: positiveInteger(
      explicit.timeoutMs ?? legacy.timeoutMs ?? existing.timeoutMs,
      120000,
    ),
    maxPages: positiveInteger(
      explicit.maxPages ?? legacy.maxPages ?? existing.maxPages,
      1,
    ),
    skills,
    args: {
      ...(existing.args && typeof existing.args === 'object' ? existing.args : {}),
      ...(legacy.args && typeof legacy.args === 'object' ? legacy.args : {}),
      ...(explicit.args && typeof explicit.args === 'object' ? explicit.args : {}),
    },
  };
}

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
    if (value === undefined || value === null || value === '') continue;
    if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
      options[key] = config[key];
      continue;
    }
    if (options[key] === undefined) {
      options[key] = value;
    }
  }

  if (options.jsEyesSkill && !options.jsEyesSkills) {
    options.jsEyesSkills = parseProviderSkills(options.jsEyesSkill);
  }

  const legacyProvider = buildProviderFromLegacy(config, options);
  const explicitProvider = config.provider && typeof config.provider === 'object'
    ? config.provider
    : {};
  const provider = mergeProvider(config.provider, legacyProvider, explicitProvider);

  const merged = {
    ...config,
    options,
    provider,
  };

  for (const [key, value] of Object.entries(legacy)) {
    if (options[key] !== undefined) {
      merged[key] = options[key];
    }
  }

  merged.jsEyesSkills = provider.skills;
  merged.jsEyesSkill = provider.skills[0];
  merged.jsEyesCli = provider.cli;
  merged.jsEyesServerUrl = provider.serverUrl;
  merged.jsEyesTimeoutMs = provider.timeoutMs;
  merged.jsEyesMaxPages = provider.maxPages;
  merged.jsEyesArgs = provider.args;

  options.jsEyesSkills = provider.skills;
  options.jsEyesSkill = provider.skills[0];
  options.jsEyesCli = provider.cli;
  options.jsEyesServerUrl = provider.serverUrl;
  options.jsEyesTimeoutMs = provider.timeoutMs;
  options.jsEyesMaxPages = provider.maxPages;
  options.jsEyesArgs = provider.args;
  options.provider = provider;

  return merged;
}
