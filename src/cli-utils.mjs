import { normalizeSearchConfig, parseJsEyesSkills } from 'js-deepresearch-engine';

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
    'js-eyes-cli': 'search.jsEyesCli',
    'js-eyes-server-url': 'search.jsEyesServerUrl',
    'js-eyes-max-pages': 'search.jsEyesMaxPages',
    'js-eyes-timeout-ms': 'search.jsEyesTimeoutMs',
  };

  for (const [flag, key] of Object.entries(mappings)) {
    if (flags[flag] !== undefined) {
      setDeepValue(settings, key, flags[flag]);
    }
  }

  const jsEyesSkillValue = flags['js-eyes-skill'] ?? flags['js-eyes-skills'];
  if (jsEyesSkillValue !== undefined) {
    const jsEyesSkills = parseJsEyesSkills(jsEyesSkillValue);
    settings.search ||= {};
    settings.search.jsEyesSkills = jsEyesSkills;
    settings.search.jsEyesSkill = jsEyesSkills[0];
  }

  if (settings.search) {
    settings.search = normalizeSearchConfig(settings.search);
  }

  return settings;
}

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
