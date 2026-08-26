import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deprecatedStrategyError,
  mapHistoricalStrategy,
  matchesStrategyFilter,
  sessionMatchesStrategyFilter,
  migrateResearchSettings,
  researchSettingsNeedMigration,
} from '../src/research/strategy-aliases.mjs';

describe('strategy aliases', () => {
  it('maps historical IDs on the read path only', () => {
    assert.equal(mapHistoricalStrategy('rapid'), 'quick');
    assert.equal(mapHistoricalStrategy('parallel'), 'quick');
    assert.equal(mapHistoricalStrategy('source-based'), 'focused');
    assert.equal(mapHistoricalStrategy('adaptive'), 'focused');
    assert.equal(mapHistoricalStrategy('adaptive', { loopVersion: 'v1' }), 'focused');
    assert.equal(mapHistoricalStrategy('adaptive', { loopVersion: 'v2' }), 'exploratory');
    assert.equal(mapHistoricalStrategy('adaptive', { trace: [{ reasonCode: 'agent_loop_v2' }] }), 'exploratory');
    assert.equal(mapHistoricalStrategy('focused'), 'focused');
    assert.equal(mapHistoricalStrategy('custom'), 'custom');
  });

  it('matches historical work_dir names for live strategy filters', () => {
    assert.equal(matchesStrategyFilter('rapid', 'quick'), true);
    assert.equal(matchesStrategyFilter('parallel', 'quick'), true);
    assert.equal(matchesStrategyFilter('source-based', 'focused'), true);
    assert.equal(matchesStrategyFilter('adaptive', 'focused'), true);
    assert.equal(matchesStrategyFilter('adaptive', 'exploratory'), true);
    assert.equal(matchesStrategyFilter('adaptive', 'focused', { loopVersion: 'v2' }), false);
    assert.equal(matchesStrategyFilter('adaptive', 'exploratory', { loopVersion: 'v2' }), true);
    assert.equal(matchesStrategyFilter('focused', 'focused'), true);
    assert.equal(matchesStrategyFilter('quick', 'focused'), false);
  });

  it('classifies adaptive work_dir sessions by loop version or trace', () => {
    assert.equal(sessionMatchesStrategyFilter({ directoryName: 'adaptive', meta: { settings: { adaptive: { loopVersion: 'v1' } } } }, 'focused'), true);
    assert.equal(sessionMatchesStrategyFilter({ directoryName: 'adaptive', meta: { settings: { adaptive: { loopVersion: 'v2' } } } }, 'focused'), false);
    assert.equal(sessionMatchesStrategyFilter({ directoryName: 'adaptive', meta: { settings: { adaptive: { loopVersion: 'v2' } } } }, 'exploratory'), true);
    assert.equal(sessionMatchesStrategyFilter({ directoryName: 'adaptive', trace: [{ reasonCode: 'agent_loop_v2' }] }, 'exploratory'), true);
    assert.equal(sessionMatchesStrategyFilter({ directoryName: 'source-based' }, 'focused'), true);
  });

  it('migrates nested research settings to live keys', () => {
    const migrated = migrateResearchSettings({
      strategy: 'source-based',
      sourceBased: { fetchMode: 'full', adaptiveControl: { enabled: false } },
      adaptive: { loopVersion: 'v2', maxSteps: 11 },
    });
    assert.equal(migrated.strategy, 'focused');
    assert.equal(migrated.focused.fetchMode, 'full');
    assert.equal(migrated.focused.iterationControl.enabled, false);
    assert.equal(migrated.exploratory.maxSteps, 11);
    assert.equal(migrated.exploratory.loopVersion, undefined);
    assert.equal(migrated.sourceBased, undefined);
    assert.equal(migrated.adaptive, undefined);
    assert.equal(researchSettingsNeedMigration(migrated), false);
  });

  it('explains retired CLI strategy IDs', () => {
    assert.match(deprecatedStrategyError('parallel').message, /quick with --iterations > 1/);
    assert.match(deprecatedStrategyError('adaptive').message, /exploratory/);
  });
});
