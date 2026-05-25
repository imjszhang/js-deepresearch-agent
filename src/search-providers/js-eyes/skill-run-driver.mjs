import { getSkillProfile } from './skill-registry.mjs';
import { appendFlag } from './cli-process.mjs';

export function buildSkillRunPreCommand(query, skillId, provider) {
  const profile = getSkillProfile(skillId);
  if (!profile.preCommand) return null;

  const args = [
    'skill',
    'run',
    skillId,
    profile.preCommand,
    query,
  ];

  if (provider.serverUrl) {
    appendFlag(args, profile.serverFlag || '--server', provider.serverUrl);
  }

  return args;
}

export function buildSkillRunCommand(query, skillId, provider) {
  const profile = getSkillProfile(skillId);
  const args = [
    'skill',
    'run',
    skillId,
    profile.command || 'search',
    query,
  ];

  appendFlag(args, profile.limitFlag || '--limit', provider.maxResults);

  if (profile.supportsMaxPages && provider.maxPages) {
    appendFlag(args, '--max-pages', provider.maxPages);
  }

  if (provider.serverUrl) {
    appendFlag(args, profile.serverFlag || '--server', provider.serverUrl);
  }

  if (profile.supportsTimeoutMs && provider.timeoutMs) {
    appendFlag(args, '--timeout-ms', provider.timeoutMs);
  }

  if (profile.supportsQuiet) {
    args.push('--quiet');
  }

  for (const [key, value] of Object.entries(profile.extraArgs || {})) {
    appendFlag(args, key, value);
  }

  for (const [key, value] of Object.entries(provider.args || {})) {
    appendFlag(args, key, value);
  }

  return args;
}
