import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('CLI package entry', () => {
  it('publishes both CLI aliases through an executable entry file', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.bin.jdr, 'src/cli.mjs');
    assert.equal(pkg.bin['js-deepresearch-agent'], 'src/cli.mjs');
    if (process.platform !== 'win32') {
      assert.notEqual(fs.statSync(path.join(root, 'src', 'cli.mjs')).mode & 0o111, 0);
    }
  });
});
