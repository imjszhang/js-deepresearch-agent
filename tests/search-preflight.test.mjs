import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeSearchProvider } from '../src/search-preflight.mjs';

describe('search preflight', () => {
  it('does not call the planner path when SearXNG is unreachable', async () => {
    await assert.rejects(
      () => probeSearchProvider({
        search: { engine: 'searxng', baseUrl: 'http://127.0.0.1:1' },
      }, {
        fetchImpl: async () => {
          throw new Error('connect failed');
        },
        timeoutMs: 50,
      }),
      /SearXNG is not reachable/,
    );
  });

  it('points at js-eyes doctor when the server and CLI are down', async () => {
    await assert.rejects(
      () => probeSearchProvider({
        search: {
          engine: 'js-eyes',
          provider: { serverUrl: 'ws://127.0.0.1:1', cli: 'js-eyes-missing' },
        },
      }, {
        timeoutMs: 50,
        spawnImpl() {
          throw new Error('spawn failed');
        },
      }),
      /js-eyes doctor --json/,
    );
  });

  it('skips probe for local corpus search', async () => {
    const result = await probeSearchProvider({ search: { engine: 'local' } });
    assert.equal(result.ok, true);
  });
});
