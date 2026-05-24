import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatHistory, getDeepValue, parseArgs, setDeepValue } from '../src/cli-utils.mjs';

describe('CLI utilities', () => {
  it('parses positional args and flags', () => {
    const parsed = parseArgs(['hello', 'world', '--strategy', 'quick', '--json']);
    assert.deepEqual(parsed.args, ['hello', 'world']);
    assert.equal(parsed.flags.strategy, 'quick');
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
});
