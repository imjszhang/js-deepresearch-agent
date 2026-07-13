/** @typedef {{ label: string, strategy: string, loopVersion?: string }} StrategyPreset */

/** @type {Record<string, StrategyPreset>} */
export const STRATEGY_PRESETS = {
  'source-based': { label: 'source-based', strategy: 'source-based' },
  'adaptive-v1': { label: 'adaptive-v1', strategy: 'adaptive', loopVersion: 'v1' },
  'adaptive-v2': { label: 'adaptive-v2', strategy: 'adaptive', loopVersion: 'v2' },
};

export const DEFAULT_STRATEGY_COMPARE_ORDER = ['source-based', 'adaptive-v1', 'adaptive-v2'];

export function parseStrategyList(raw) {
  const labels = String(raw || DEFAULT_STRATEGY_COMPARE_ORDER.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const unknown = labels.filter((label) => !STRATEGY_PRESETS[label]);
  if (unknown.length > 0) {
    throw new Error(`Unknown strategy preset(s): ${unknown.join(', ')}. Expected: ${Object.keys(STRATEGY_PRESETS).join(', ')}`);
  }

  return labels.map((label) => STRATEGY_PRESETS[label]);
}

export function applyStrategyPreset(baseSettings, preset) {
  const settings = JSON.parse(JSON.stringify(baseSettings || {}));
  settings.research ||= {};
  settings.research.strategy = preset.strategy;
  if (preset.loopVersion) {
    settings.research.adaptive ||= {};
    settings.research.adaptive.loopVersion = preset.loopVersion;
  } else if (settings.research.adaptive?.loopVersion) {
    delete settings.research.adaptive.loopVersion;
  }
  return settings;
}
