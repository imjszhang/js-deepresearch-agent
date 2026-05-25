import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSearchConfig } from '../src/search/normalize-search-config.mjs';

describe('normalizeSearchConfig', () => {
  it('merges legacy jsEyes fields into options while preserving compatibility', () => {
    const normalized = normalizeSearchConfig({
      engine: 'js-eyes',
      maxResults: 8,
      jsEyesCli: 'custom-js-eyes',
      jsEyesSkill: 'js-x-ops-skill,js-zhihu-ops-skill',
      jsEyesServerUrl: 'ws://127.0.0.1:18080',
      jsEyesMaxPages: 2,
      jsEyesTimeoutMs: 45000,
      jsEyesArgs: { sort: 'top' },
    });

    assert.equal(normalized.jsEyesCli, 'custom-js-eyes');
    assert.deepEqual(normalized.jsEyesSkills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
    assert.equal(normalized.options.jsEyesCli, 'custom-js-eyes');
    assert.deepEqual(normalized.options.jsEyesSkills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
    assert.equal(normalized.options.jsEyesServerUrl, 'ws://127.0.0.1:18080');
    assert.equal(normalized.options.jsEyesMaxPages, 2);
    assert.deepEqual(normalized.options.jsEyesArgs, { sort: 'top' });
  });

  it('prefers explicit options over legacy fields', () => {
    const normalized = normalizeSearchConfig({
      jsEyesCli: 'legacy-cli',
      options: {
        jsEyesCli: 'options-cli',
      },
    });

    assert.equal(normalized.jsEyesCli, 'options-cli');
    assert.equal(normalized.options.jsEyesCli, 'options-cli');
  });
});
