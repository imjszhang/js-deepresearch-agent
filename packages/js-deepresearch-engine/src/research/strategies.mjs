import { buildStrategyContext } from './strategy-context.mjs';
import { exploratoryStrategyDefinition, runExploratory } from './strategies/exploratory.mjs';
import { focusedStrategyDefinition, runFocused } from './strategies/focused.mjs';
import { quickStrategyDefinition, runQuick } from './strategies/quick.mjs';

const BUILTIN_STRATEGIES = [
  { ...quickStrategyDefinition, run: runQuick },
  { ...focusedStrategyDefinition, run: runFocused },
  { ...exploratoryStrategyDefinition, run: runExploratory },
];

const strategyRegistry = {};

function registerBuiltins() {
  for (const strategy of BUILTIN_STRATEGIES) {
    strategyRegistry[strategy.id] = strategy;
  }
}

registerBuiltins();

function buildStrategyMetadata() {
  return Object.values(strategyRegistry).map(({
    id,
    label,
    labelEn,
    description,
    descriptionEn,
    requiresLlm,
    supportsIterations,
    supportsConcurrency,
    speed,
    depth,
  }) => ({
    id,
    label,
    labelEn,
    description,
    descriptionEn,
    requiresLlm,
    supportsIterations,
    supportsConcurrency,
    speed,
    depth,
  }));
}

export let strategyMetadata = buildStrategyMetadata();

/**
 * Read-only view of registered strategies. Prefer `registerStrategy()` over
 * mutating this object directly.
 */
export function getStrategyRegistry() {
  return { ...strategyRegistry };
}

/** @deprecated Prefer `getStrategyRegistry()`; direct mutation is discouraged. */
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
    labelEn: entry.labelEn || entry.label || id,
    description: entry.description || '',
    descriptionEn: entry.descriptionEn || entry.description || '',
    requiresLlm: entry.requiresLlm ?? true,
    supportsIterations: entry.supportsIterations ?? false,
    supportsConcurrency: entry.supportsConcurrency ?? true,
    speed: entry.speed || 'balanced',
    depth: entry.depth || 'balanced',
    progressProfile: entry.progressProfile,
    run: entry.run,
  };
  strategyMetadata = buildStrategyMetadata();
}

export function resetStrategyRegistry() {
  for (const key of Object.keys(strategyRegistry)) {
    delete strategyRegistry[key];
  }
  registerBuiltins();
  strategyMetadata = buildStrategyMetadata();
}

export async function runStrategy({ strategy, ...input }) {
  const entry = strategyRegistry[strategy];
  if (!entry) {
    throw new Error(`Unsupported research strategy: ${strategy}`);
  }

  const context = buildStrategyContext({
    ...input,
    progressProfile: entry.progressProfile,
  });
  return entry.run(context);
}
