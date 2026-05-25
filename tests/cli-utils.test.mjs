import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyResearchFlags,
  formatHistory,
  getDeepValue,
  parseArgs,
  setDeepValue,
} from '../src/cli-utils.mjs';

describe('CLI utilities', () => {
  it('parses positional args and flags', () => {
    const parsed = parseArgs(['hello', 'world', '--strategy', 'rapid', '--json']);
    assert.deepEqual(parsed.args, ['hello', 'world']);
    assert.equal(parsed.flags.strategy, 'rapid');
    assert.equal(parsed.flags.json, true);
  });

  it('sets and gets nested values', () => {
    const target = { llm: { provider: 'openai-compatible' } };
    setDeepValue(target, 'llm.provider', 'ollama');
    setDeepValue(target, 'research.questionsPerIteration', '4');

    assert.equal(getDeepValue(target, 'llm.provider'), 'ollama');
    assert.equal(getDeepValue(target, 'research.questionsPerIteration'), 4);
  });

  it('formats empty history', () => {
    assert.equal(formatHistory([]), 'No research history.');
  });

  it('maps js-eyes skill flags into search settings', () => {
    const settings = applyResearchFlags({
      search: { engine: 'js-eyes', jsEyesSkill: 'js-zhihu-ops-skill' },
    }, {
      'js-eyes-skill': 'js-x-ops-skill,js-zhihu-ops-skill',
    });

    assert.equal(settings.search.jsEyesSkill, 'js-x-ops-skill');
    assert.deepEqual(settings.search.jsEyesSkills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
    assert.deepEqual(settings.search.options.jsEyesSkills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
  });

  it('normalizes js-eyes-skills alias and deduplicates entries', () => {
    const settings = applyResearchFlags({ search: {} }, {
      'js-eyes-skills': ' a ; a b ',
    });

    assert.equal(settings.search.jsEyesSkill, 'a');
    assert.deepEqual(settings.search.jsEyesSkills, ['a', 'b']);
  });

  it('maps other js-eyes runtime flags for one-off research runs', () => {
    const settings = applyResearchFlags({ search: {} }, {
      search: 'js-eyes',
      'js-eyes-cli': 'custom-js-eyes',
      'js-eyes-server-url': 'ws://127.0.0.1:18080',
      'js-eyes-max-pages': '2',
      'js-eyes-timeout-ms': '45000',
    });

    assert.equal(settings.search.engine, 'js-eyes');
    assert.equal(settings.search.jsEyesCli, 'custom-js-eyes');
    assert.equal(settings.search.jsEyesServerUrl, 'ws://127.0.0.1:18080');
    assert.equal(settings.search.jsEyesMaxPages, 2);
    assert.equal(settings.search.jsEyesTimeoutMs, 45000);
  });
});
