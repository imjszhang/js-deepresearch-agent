import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const strategyModules = [
  '../src/research/strategies.mjs',
  '../src/research/strategies/rapid.mjs',
  '../src/research/strategies/source-based.mjs',
  '../src/research/strategies/parallel.mjs',
  '../src/research/strategies/iterative.mjs',
];

describe('research strategies decoupling', () => {
  for (const modulePath of strategyModules) {
    it(`does not import concrete search engines from ${path.basename(modulePath)}`, () => {
      const sourcePath = path.join(import.meta.dirname, modulePath);
      const source = fs.readFileSync(sourcePath, 'utf8');

      assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/search\/engines\//);
      assert.doesNotMatch(source, /from ['"]\.\.\/search\/engines\//);
    });
  }

  it('uses shared concurrency resolution instead of engine-specific imports', () => {
    const iterativePath = path.join(import.meta.dirname, '../src/research/strategies/iterative.mjs');
    const source = fs.readFileSync(iterativePath, 'utf8');

    assert.match(source, /resolveStrategyConcurrency/);
  });
});
