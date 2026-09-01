import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const strategyModules = [
  '../src/research/strategies.mjs',
  '../src/research/strategies/quick.mjs',
  '../src/research/strategies/focused.mjs',
  '../src/research/strategies/exploratory.mjs',
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

  it('does not import the benchmark query battery from runtime engine code', () => {
    const srcRoot = path.join(import.meta.dirname, '../src');
    const stack = [srcRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.name.endsWith('.mjs')) continue;
        const source = fs.readFileSync(full, 'utf8');
        assert.doesNotMatch(source, /query-battery/);
        assert.doesNotMatch(source, /apple-silicon-local-llm/);
      }
    }
  });
});
