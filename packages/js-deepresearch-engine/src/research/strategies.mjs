import { formatSourcesForQuestionContext, generateQuestions } from './question-generator.mjs';
import { searchQuestions } from './search-executor.mjs';
import { resolveSearchConcurrency } from '../search/search-capabilities.mjs';

const strategyRegistry = {
  rapid: {
    id: 'rapid',
    label: 'Rapid',
    description: 'Search the original query and a few fast follow-up questions before synthesis.',
    requiresLlm: true,
    supportsIterations: false,
    supportsConcurrency: true,
    speed: 'fast',
    depth: 'light',
    run: runRapid,
  },
  'source-based': {
    id: 'source-based',
    label: 'Source Based',
    description: 'Iteratively generate source-informed questions and search with controlled concurrency.',
    requiresLlm: true,
    supportsIterations: true,
    supportsConcurrency: true,
    speed: 'balanced',
    depth: 'deep',
    run: runSourceBased,
  },
  parallel: {
    id: 'parallel',
    label: 'Parallel',
    description: 'Generate focused research questions and search them with higher concurrency.',
    requiresLlm: true,
    supportsIterations: true,
    supportsConcurrency: true,
    speed: 'fast',
    depth: 'broad',
    run: runParallel,
  },
};

function buildStrategyMetadata() {
  return Object.values(strategyRegistry).map(({
    id,
    label,
    description,
    requiresLlm,
    supportsIterations,
    supportsConcurrency,
    speed,
    depth,
  }) => ({
    id,
    label,
    description,
    requiresLlm,
    supportsIterations,
    supportsConcurrency,
    speed,
    depth,
  }));
}

export let strategyMetadata = buildStrategyMetadata();

export { strategyRegistry };

export function registerStrategy(id, entry) {
  if (!id || typeof id !== 'string') {
    throw new Error('Strategy id is required.');
  }
  if (typeof entry.run !== 'function') {
    throw new Error(`Strategy "${id}" requires a run function.`);
  }
  strategyRegistry[id] = {
    id,
    label: entry.label || id,
    description: entry.description || '',
    requiresLlm: entry.requiresLlm ?? true,
    supportsIterations: entry.supportsIterations ?? false,
    supportsConcurrency: entry.supportsConcurrency ?? true,
    speed: entry.speed || 'balanced',
    depth: entry.depth || 'balanced',
    run: entry.run,
  };
  strategyMetadata = buildStrategyMetadata();
}

export async function runStrategy({ strategy, ...context }) {
  const entry = strategyRegistry[strategy];
  if (!entry) {
    throw new Error(`Unsupported research strategy: ${strategy}`);
  }
  return entry.run(context);
}

async function runRapid({ query, settings, llm, search, signal, emit }) {
  const followUpCount = Math.min(getQuestionCount(settings), 3);
  const concurrency = getConcurrency(settings, search, followUpCount + 1);

  emit('Generating rapid follow-up questions', 10);
  const followUps = await generateQuestions({
    llm,
    query,
    count: followUpCount,
    signal,
    mode: 'rapid',
  });
  const questions = [query, ...followUps];

  emit(`Running ${uniqueQuestionCount(questions)} rapid searches`, 25);
  return searchQuestions({
    questions,
    search,
    signal,
    concurrency,
    onProgress: ({ completed, total, question }) => {
      emit(`Rapid search complete: ${question}`, 25 + Math.round((completed / total) * 45));
    },
  });
}

async function runSourceBased({ query, settings, llm, search, signal, emit }) {
  const iterations = getIterationCount(settings);
  const count = getQuestionCount(settings);
  const concurrency = getConcurrency(settings, search, count + 1);
  const findings = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const progressBase = 10 + Math.round(((iteration - 1) / iterations) * 60);
    const context = iteration === 1 ? '' : formatSourcesForQuestionContext(findings);
    emit(`Generating research questions for iteration ${iteration}/${iterations}`, progressBase);
    const questions = await generateQuestions({
      llm,
      query,
      count,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context,
    });

    const iterationQuestions = iteration === 1 ? [query, ...questions] : questions;
    emit(`Searching iteration ${iteration}/${iterations}`, progressBase + 5);
    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency,
      onProgress: ({ completed, total }) => {
        const searchProgress = progressBase + 5 + Math.round((completed / total) * (50 / iterations));
        emit(`Completed ${completed}/${total} searches for iteration ${iteration}`, searchProgress);
      },
    });
    findings.push(...results.map((finding) => ({ ...finding, iteration })));
  }

  return findings;
}

async function runParallel({ query, settings, llm, search, signal, emit }) {
  const iterations = getIterationCount(settings);
  const count = getQuestionCount(settings);
  const concurrency = getConcurrency(settings, search, count + 1);
  const findings = [];

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const progressBase = 10 + Math.round(((iteration - 1) / iterations) * 60);
    const context = iteration === 1 ? '' : formatSourcesForQuestionContext(findings);
    emit(`Generating parallel questions for iteration ${iteration}/${iterations}`, progressBase);
    const questions = await generateQuestions({
      llm,
      query,
      count,
      signal,
      mode: iteration === 1 ? 'initial' : 'followup',
      context,
    });

    const iterationQuestions = iteration === 1 ? [query, ...questions] : questions;
    emit(`Running ${uniqueQuestionCount(iterationQuestions)} parallel searches`, progressBase + 5);
    const results = await searchQuestions({
      questions: iterationQuestions,
      search,
      signal,
      concurrency,
      onProgress: ({ completed, total }) => {
        const searchProgress = progressBase + 5 + Math.round((completed / total) * (50 / iterations));
        emit(`Completed ${completed}/${total} parallel searches for iteration ${iteration}`, searchProgress);
      },
    });
    findings.push(...results.map((finding) => ({ ...finding, iteration })));
  }

  return findings;
}

function getIterationCount(settings) {
  return positiveInteger(settings.research?.iterations, 1);
}

function getQuestionCount(settings) {
  return positiveInteger(settings.research?.questionsPerIteration, 3);
}

function getConcurrency(settings, search, fallback) {
  return resolveSearchConcurrency(search, settings, fallback);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function uniqueQuestionCount(questions) {
  return new Set((questions || []).map((question) => String(question || '').trim()).filter(Boolean)).size;
}
