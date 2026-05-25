import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('research strategies decoupling', () => {
  it('does not import the js-eyes search engine module directly', () => {
    const strategiesPath = path.join(
      import.meta.dirname,
      '../src/research/strategies.mjs',
    );
    const source = fs.readFileSync(strategiesPath, 'utf8');

    assert.doesNotMatch(source, /from ['"]\.\.\/search\/engines\/js-eyes\.mjs['"]/);
    assert.match(source, /resolveSearchConcurrency/);
  });
});
