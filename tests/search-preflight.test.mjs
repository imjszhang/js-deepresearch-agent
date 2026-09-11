import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
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

  it('points at js-eyes doctor when the server and CLI are down', async t => {
    let tcpCalls = 0, doctorCalls = 0;
    t.mock.method(net, 'createConnection', () => {
      tcpCalls++;
      const socket = new EventEmitter();
      socket.destroy = () => {};
      process.nextTick(() => socket.emit('error', new Error('fixture connection refused')));
      return socket;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(
      () => probeSearchProvider({
        search: {
          engine: 'js-eyes',
          provider: { serverUrl: 'ws://127.0.0.1:1', cli: 'js-eyes-missing' },
        },
      }, {
        timeoutMs: 50,
        spawnImpl() {
          doctorCalls++;
          throw new Error('spawn failed');
        },
      }),
      /js-eyes doctor --json/,
    );
    assert.equal(tcpCalls, 1);
    assert.equal(doctorCalls, 1);
  });

  it('skips probe for local corpus search', async () => {
    const result = await probeSearchProvider({ search: { engine: 'local' } });
    assert.equal(result.ok, true);
  });
});
