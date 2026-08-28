export const LIVE_STRATEGY_IDS = Object.freeze(['quick', 'focused', 'exploratory']);

export const DEPRECATED_STRATEGY_HINTS = Object.freeze({
  rapid: 'quick (1 iteration = former Rapid)',
  parallel: 'quick with --iterations > 1 (former Parallel)',
  'source-based': 'focused',
  adaptive: 'exploratory (former Adaptive v2) or focused (former Adaptive v1 / source-based)',
});

const HISTORICAL_DIRECTORY_GROUPS = Object.freeze({
  quick: Object.freeze(['quick', 'rapid', 'parallel']),
  focused: Object.freeze(['focused', 'source-based', 'adaptive']),
  exploratory: Object.freeze(['exploratory', 'adaptive']),
});

export function isLiveStrategyId(id) {
  return LIVE_STRATEGY_IDS.includes(id);
}

export function isDeprecatedStrategyId(id) {
  return Object.hasOwn(DEPRECATED_STRATEGY_HINTS, id);
}

export function deprecatedStrategyError(strategy) {
  const hint = DEPRECATED_STRATEGY_HINTS[strategy];
  return new Error(
    hint
      ? `Strategy "${strategy}" is no longer supported. Use --strategy ${hint}.`
      : `Unsupported research strategy: ${strategy}`,
  );
}

function resolveLegacyLoopVersion(context = {}) {
  return context.loopVersion
    ?? context.meta?.settings?.adaptive?.loopVersion
    ?? context.meta?.adaptive?.loopVersion
    ?? context.settings?.adaptive?.loopVersion
    ?? context.settings?.research?.adaptive?.loopVersion
    ?? context.research?.adaptive?.loopVersion
    ?? null;
}

function traceLooksLikeAdaptiveV2(trace) {
  return Array.isArray(trace) && trace.some((entry) => (
    entry?.reasonCode === 'agent_loop_v2' || entry?.reasonCode === 'exploratory_loop'
  ));
}

/**
 * Map historical strategy IDs to live IDs. Read-path / settings migration only.
 */
export function mapHistoricalStrategy(strategy, context = {}) {
  if (!strategy || isLiveStrategyId(strategy)) return strategy;
  if (strategy === 'rapid' || strategy === 'parallel') return 'quick';
  if (strategy === 'source-based') return 'focused';
  if (strategy === 'adaptive') {
    const loopVersion = resolveLegacyLoopVersion(context);
    if (loopVersion === 'v2' || traceLooksLikeAdaptiveV2(context.trace)) return 'exploratory';
    return 'focused';
  }
  return strategy;
}

export function historicalDirectoriesFor(strategyOrFilter) {
  if (!strategyOrFilter) return [];
  const mapped = mapHistoricalStrategy(strategyOrFilter);
  const group = HISTORICAL_DIRECTORY_GROUPS[mapped] || [strategyOrFilter];
  return [...new Set([strategyOrFilter, mapped, ...group])];
}

export function matchesStrategyFilter(directoryName, filter, context = {}) {
  if (!filter) return true;
  const liveFilter = isLiveStrategyId(filter) ? filter : mapHistoricalStrategy(filter, context);
  if (!historicalDirectoriesFor(liveFilter).includes(directoryName) && directoryName !== liveFilter) {
    return false;
  }
  if (directoryName !== 'adaptive') return true;
  if (!hasAdaptiveLoopHint(context)) return true;
  return mapHistoricalStrategy(directoryName, context) === liveFilter;
}

function hasAdaptiveLoopHint(context = {}) {
  return resolveLegacyLoopVersion(context) != null || traceLooksLikeAdaptiveV2(context.trace);
}

/**
 * Filter a work_dir session after reading meta/trace. Adaptive v1 maps to
 * focused; Adaptive v2 maps to exploratory.
 */
export function sessionMatchesStrategyFilter({ directoryName, meta, trace } = {}, filter) {
  if (!filter) return true;
  const context = {
    meta,
    trace,
    settings: meta?.settings,
    loopVersion: meta?.settings?.adaptive?.loopVersion
      ?? meta?.settings?.research?.adaptive?.loopVersion
      ?? meta?.adaptive?.loopVersion,
  };
  return matchesStrategyFilter(directoryName, filter, context)
    && mapHistoricalStrategy(directoryName, context) === (isLiveStrategyId(filter) ? filter : mapHistoricalStrategy(filter, context));
}

function migrateFocusedBlock(raw = {}) {
  const next = { ...raw };
  if (next.adaptiveControl && !next.iterationControl) {
    next.iterationControl = next.adaptiveControl;
  }
  delete next.adaptiveControl;
  return next;
}

function migrateExploratoryBlock(raw = {}) {
  const next = { ...raw };
  delete next.loopVersion;
  if (next.minLlmTokens === undefined && next.targetLlmTokens !== undefined) {
    next.minLlmTokens = next.targetLlmTokens;
  }
  if (next.targetLlmTokens === undefined && next.minLlmTokens !== undefined) {
    next.targetLlmTokens = next.minLlmTokens;
  }
  return next;
}

/**
 * Rewrite persisted or override research settings to the live strategy IDs/keys.
 */
export function migrateResearchSettings(research = {}) {
  if (!research || typeof research !== 'object') return {};
  const next = { ...research };

  if (next.sourceBased || next.focused) {
    next.focused = migrateFocusedBlock({
      ...(next.sourceBased || {}),
      ...(next.focused || {}),
    });
  }
  delete next.sourceBased;

  if (next.adaptive || next.exploratory) {
    next.exploratory = migrateExploratoryBlock({
      ...(next.adaptive || {}),
      ...(next.exploratory || {}),
    });
  }

  if (next.strategy && !isLiveStrategyId(next.strategy)) {
    next.strategy = mapHistoricalStrategy(next.strategy, {
      loopVersion: research.adaptive?.loopVersion || research.exploratory?.loopVersion,
      research,
    });
  }

  delete next.adaptive;
  return next;
}

export function researchSettingsNeedMigration(research = {}) {
  if (!research || typeof research !== 'object') return false;
  if (research.sourceBased || research.adaptive) return true;
  if (research.focused?.adaptiveControl) return true;
  if (research.exploratory?.loopVersion !== undefined || research.adaptive?.loopVersion !== undefined) return true;
  if (research.strategy && isDeprecatedStrategyId(research.strategy)) return true;
  return false;
}
