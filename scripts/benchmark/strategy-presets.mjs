/** @typedef {{ label: string, strategy: string }} StrategyPreset */

/** @type {Record<string, StrategyPreset>} */
export const STRATEGY_PRESETS = {
  quick: { label: 'quick', strategy: 'quick' },
  focused: { label: 'focused', strategy: 'focused' },
  exploratory: { label: 'exploratory', strategy: 'exploratory' },
};

export const DEFAULT_STRATEGY_COMPARE_ORDER = ['quick', 'focused', 'exploratory'];

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
  return settings;
}
