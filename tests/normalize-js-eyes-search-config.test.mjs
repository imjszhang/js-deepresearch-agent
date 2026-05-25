import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeJsEyesSearchConfig } from '../src/search-providers/js-eyes/normalize-js-eyes-search-config.mjs';

describe('normalizeJsEyesSearchConfig', () => {
  it('merges legacy jsEyes fields into options while preserving compatibility', () => {
    const normalized = normalizeJsEyesSearchConfig({
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
    assert.equal(normalized.provider.cli, 'custom-js-eyes');
    assert.deepEqual(normalized.provider.skills, ['js-x-ops-skill', 'js-zhihu-ops-skill']);
    assert.equal(normalized.provider.serverUrl, 'ws://127.0.0.1:18080');
  });

  it('prefers top-level legacy fields over options when both are present', () => {
    const normalized = normalizeJsEyesSearchConfig({
      jsEyesCli: 'legacy-cli',
      options: {
        jsEyesCli: 'options-cli',
      },
    });

    assert.equal(normalized.jsEyesCli, 'legacy-cli');
    assert.equal(normalized.options.jsEyesCli, 'legacy-cli');
    assert.equal(normalized.provider.cli, 'legacy-cli');
  });

  it('uses options when top-level legacy field is absent', () => {
    const normalized = normalizeJsEyesSearchConfig({
      options: {
        jsEyesCli: 'options-cli',
      },
    });

    assert.equal(normalized.jsEyesCli, 'options-cli');
    assert.equal(normalized.options.jsEyesCli, 'options-cli');
    assert.equal(normalized.provider.cli, 'options-cli');
  });

  it('prefers top-level legacy jsEyesSkills over stale options', () => {
    const normalized = normalizeJsEyesSearchConfig({
      jsEyesSkill: 'js-reddit-ops-skill',
      jsEyesSkills: ['js-reddit-ops-skill'],
      options: {
        jsEyesSkill: 'js-x-ops-skill',
        jsEyesSkills: ['js-x-ops-skill'],
      },
    });

    assert.equal(normalized.jsEyesSkill, 'js-reddit-ops-skill');
    assert.deepEqual(normalized.jsEyesSkills, ['js-reddit-ops-skill']);
    assert.deepEqual(normalized.options.jsEyesSkills, ['js-reddit-ops-skill']);
    assert.deepEqual(normalized.provider.skills, ['js-reddit-ops-skill']);
  });

  it('merges explicit provider config over legacy fields', () => {
    const normalized = normalizeJsEyesSearchConfig({
      jsEyesSkill: 'js-x-ops-skill',
      provider: {
        skills: ['js-reddit-ops-skill'],
        driver: 'skill-run',
      },
    });

    assert.deepEqual(normalized.provider.skills, ['js-reddit-ops-skill']);
    assert.equal(normalized.provider.driver, 'skill-run');
  });
});
