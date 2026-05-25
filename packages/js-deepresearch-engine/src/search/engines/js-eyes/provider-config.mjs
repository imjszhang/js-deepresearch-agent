import { parseProviderSkills } from '../../provider-skills.mjs';
import {
  DEFAULT_CLI,
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
} from './constants.mjs';

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function resolveProviderConfig(config = {}) {
  const legacyProvider = {
    cli: config.jsEyesCli,
    serverUrl: config.jsEyesServerUrl,
    timeoutMs: config.jsEyesTimeoutMs,
    maxPages: config.jsEyesMaxPages,
    skills: config.jsEyesSkills,
    skill: config.jsEyesSkill,
    args: config.jsEyesArgs,
    driver: config.jsEyesCommand === 'skill-run' ? 'skill-run' : undefined,
  };

  const nested = config.provider && typeof config.provider === 'object'
    ? config.provider
    : {};

  const skills = parseProviderSkills(
    nested.skills ?? legacyProvider.skills ?? legacyProvider.skill,
  );

  return {
    cli: nested.cli ?? legacyProvider.cli ?? DEFAULT_CLI,
    driver: nested.driver ?? legacyProvider.driver ?? 'auto',
    serverUrl: nested.serverUrl ?? legacyProvider.serverUrl ?? '',
    timeoutMs: positiveInteger(
      nested.timeoutMs ?? legacyProvider.timeoutMs,
      DEFAULT_TIMEOUT_MS,
    ),
    maxPages: positiveInteger(
      nested.maxPages ?? legacyProvider.maxPages,
      DEFAULT_MAX_PAGES,
    ),
    skills,
    args: {
      ...(legacyProvider.args && typeof legacyProvider.args === 'object' ? legacyProvider.args : {}),
      ...(nested.args && typeof nested.args === 'object' ? nested.args : {}),
    },
    maxResults: positiveInteger(config.maxResults, 8),
  };
}

/** @deprecated use resolveProviderConfig */
export function resolveJsEyesSkills(config = {}) {
  return resolveProviderConfig(config).skills;
}
