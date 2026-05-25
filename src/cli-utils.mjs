import { normalizeSearchConfig } from 'js-deepresearch-engine';
import { parseProviderSkills } from './search-providers/js-eyes/provider-skills.mjs';
import { normalizeJsEyesSearchConfig } from './search-providers/js-eyes/normalize-js-eyes-search-config.mjs';

export function parseArgs(argv) {
  const args = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { args, flags };
}

export function setDeepValue(object, dottedKey, rawValue) {
  const parts = dottedKey.split('.');
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = coerceValue(rawValue);
  return object;
}

export function getDeepValue(object, dottedKey) {
  return dottedKey.split('.').reduce((cursor, key) => cursor?.[key], object);
}

export function formatHistory(records) {
  if (records.length === 0) return 'No research history.';
  return records.map((record) => [
    record.id,
    record.status.padEnd(9),
    new Date(record.createdAt).toLocaleString(),
    record.query,
  ].join('  ')).join('\n');
}

function resolveSkillFlag(flags) {
  return flags['search-skills']
    ?? flags['js-eyes-skill']
    ?? flags['js-eyes-skills'];
}

function applyProviderOverrides(settings, flags) {
  const providerMappings = {
    'search-cli': 'search.provider.cli',
    'js-eyes-cli': 'search.provider.cli',
    'search-server-url': 'search.provider.serverUrl',
    'js-eyes-server-url': 'search.provider.serverUrl',
    'search-max-pages': 'search.provider.maxPages',
    'js-eyes-max-pages': 'search.provider.maxPages',
    'search-timeout-ms': 'search.provider.timeoutMs',
    'js-eyes-timeout-ms': 'search.provider.timeoutMs',
  };

  for (const [flag, key] of Object.entries(providerMappings)) {
    if (flags[flag] !== undefined) {
      setDeepValue(settings, key, flags[flag]);
    }
  }

  const skillValue = resolveSkillFlag(flags);
  if (skillValue !== undefined) {
    const skills = parseProviderSkills(skillValue);
    settings.search ||= {};
    settings.search.provider ||= {};
    settings.search.provider.skills = skills;
    settings.search.jsEyesSkills = skills;
    settings.search.jsEyesSkill = skills[0];
  }
}

export function applyResearchFlags(settings, flags) {
  const mappings = {
    provider: 'llm.provider',
    model: 'llm.model',
    'base-url': 'llm.baseUrl',
    'api-key': 'llm.apiKey',
    search: 'search.engine',
    'search-base-url': 'search.baseUrl',
    'search-api-key': 'search.apiKey',
    'searxng-url': 'search.baseUrl',
    strategy: 'research.strategy',
    'work-dir': 'research.workDir',
    questions: 'research.questionsPerIteration',
    iterations: 'research.iterations',
    concurrency: 'research.concurrency',
  };

  for (const [flag, key] of Object.entries(mappings)) {
    if (flags[flag] !== undefined) {
      setDeepValue(settings, key, flags[flag]);
    }
  }

  applyProviderOverrides(settings, flags);

  if (settings.search) {
    settings.search = normalizeJsEyesSearchConfig(normalizeSearchConfig(settings.search));
  }

  return settings;
}

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
