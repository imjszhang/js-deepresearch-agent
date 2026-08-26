import {
  deprecatedStrategyError,
  isDeprecatedStrategyId,
  normalizeSearchConfig,
} from 'js-deepresearch-engine';
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
    'focused-fetch-mode': 'research.focused.fetchMode',
    'focused-fetch-backend': 'research.focused.fetchBackend',
    'focused-max-urls': 'research.focused.maxUrlsTotal',
    'focused-enable-filter': 'research.focused.enableRelevanceFilter',
    'focused-max-sources': 'research.focused.maxSourcesForReport',
    'source-fetch-mode': 'research.focused.fetchMode',
    'source-fetch-backend': 'research.focused.fetchBackend',
    'source-max-urls': 'research.focused.maxUrlsTotal',
    'source-enable-filter': 'research.focused.enableRelevanceFilter',
    'source-max-sources': 'research.focused.maxSourcesForReport',
    'max-llm-tokens': 'research.budget.maxLlmTokens',
    'max-search-requests': 'research.budget.maxSearchRequests',
    'max-source-reads': 'research.budget.maxSourceReads',
    'max-rerank-requests': 'research.budget.maxRerankRequests',
    'max-rerank-tokens': 'research.budget.maxRerankTokens',
    'reserve-report-tokens': 'research.budget.reserveReportTokens',
    'focused-iteration-control': 'research.focused.iterationControl.enabled',
    'focused-query-memory': 'research.focused.queryMemory.enabled',
    'focused-cluster-results': 'research.focused.sourceSelection.clusterResults',
    'focused-max-per-hostname': 'research.focused.sourceSelection.maxPerHostname',
    'focused-evidence-passages': 'research.focused.evidencePassages.enabled',
    'focused-claim-alignment': 'research.focused.evidencePassages.claimAlignment',
    'focused-pre-report-gate': 'research.focused.preReportGate.enabled',
    'source-adaptive-control': 'research.focused.iterationControl.enabled',
    'source-query-memory': 'research.focused.queryMemory.enabled',
    'source-cluster-results': 'research.focused.sourceSelection.clusterResults',
    'source-max-per-hostname': 'research.focused.sourceSelection.maxPerHostname',
    'source-evidence-passages': 'research.focused.evidencePassages.enabled',
    'source-claim-alignment': 'research.focused.evidencePassages.claimAlignment',
    'source-pre-report-gate': 'research.focused.preReportGate.enabled',
    'rerank-provider': 'research.providers.rerank.provider',
    'rerank-model': 'research.providers.rerank.model',
    'rerank-base-url': 'research.providers.rerank.baseUrl',
    'rerank-api-key': 'research.providers.rerank.apiKey',
    'rerank-timeout-ms': 'research.providers.rerank.timeoutMs',
    'embedding-provider': 'research.providers.embedding.provider',
    'embedding-model': 'research.providers.embedding.model',
    'embedding-base-url': 'research.providers.embedding.baseUrl',
    'embedding-api-key': 'research.providers.embedding.apiKey',
    'http-proxy': 'http.proxy',
    'exploratory-max-steps': 'research.exploratory.maxSteps',
    'exploratory-max-reads-per-step': 'research.exploratory.maxReadsPerStep',
    'exploratory-target-llm-tokens': 'research.exploratory.targetLlmTokens',
    'adaptive-max-steps': 'research.exploratory.maxSteps',
    'adaptive-max-reads-per-step': 'research.exploratory.maxReadsPerStep',
  };

  if (flags['adaptive-loop-version'] !== undefined) {
    throw new Error(
      'Flag --adaptive-loop-version has been removed. Use --strategy exploratory for the former Adaptive v2 Agent Loop, or --strategy focused for topic research.',
    );
  }

  if (flags.strategy !== undefined && isDeprecatedStrategyId(String(flags.strategy))) {
    throw deprecatedStrategyError(String(flags.strategy));
  }

  if (String(flags.strategy || '') === 'quick' && flags.iterations === undefined) {
    setDeepValue(settings, 'research.iterations', 1);
  }

  for (const [flag, key] of Object.entries(mappings)) {
    if (flags[flag] !== undefined) {
      setDeepValue(settings, key, flags[flag]);
    }
  }
  if (
    flags['focused-cluster-results'] !== undefined
    || flags['focused-max-per-hostname'] !== undefined
    || flags['source-cluster-results'] !== undefined
    || flags['source-max-per-hostname'] !== undefined
  ) {
    setDeepValue(settings, 'research.focused.sourceSelection.enabled', 'true');
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
