import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  registerContentFetchHandler,
  resetContentFetchHandlers,
  resolveUrlContent,
} from '../src/research/content-resolver.mjs';
import { TransportMemory } from '../src/research/transport-memory.mjs';

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name === 'content-type' ? 'text/html' : null;
      },
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
  };
}

function httpSettings(threshold = 3) {
  return {
    research: {
      focused: { fetchBackend: 'http' },
      read: {
        transport: {
          maxAttempts: 3,
          hostCircuitThreshold: threshold,
          responseHeadersTimeoutMs: 100,
          htmlTotalTimeoutMs: 100,
          documentTotalTimeoutMs: 200,
        },
      },
    },
  };
}

afterEach(() => resetContentFetchHandlers());

describe('run-scoped transport memory', () => {
  it('attempts the same URL/backend/path only once per run', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 3 });
    let fetches = 0;
    const context = {
      settings: httpSettings(),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return response(403);
      },
    };

    const first = await resolveUrlContent('https://blocked.test/page', context);
    const second = await resolveUrlContent('https://blocked.test/page', context);

    assert.equal(first.status, 'failed');
    assert.equal(first.fetchAttempts, 1);
    assert.equal(second.status, 'skipped');
    assert.equal(second.errorType, 'url_backend_already_attempted');
    assert.equal(second.fetchAttempts, 0);
    assert.equal(fetches, 1);
    assert.equal(memory.snapshot().attempts.length, 1);
  });

  it('allows the same URL through a different backend', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 3 });
    let httpFetches = 0;
    await resolveUrlContent('https://blocked.test/page', {
      settings: httpSettings(),
      transportMemory: memory,
      fetchImpl: async () => {
        httpFetches += 1;
        return response(403);
      },
    });

    let browserReads = 0;
    const browserHandler = async () => {
      browserReads += 1;
      return {
        status: 'ok',
        backend: 'browser:test',
        content: 'A browser backend retrieved a complete and usable source body.',
      };
    };
    browserHandler.backendId = 'browser:test';
    browserHandler.supports = () => true;
    registerContentFetchHandler(browserHandler);

    const browser = await resolveUrlContent('https://blocked.test/page', {
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      transportMemory: memory,
    });

    assert.equal(browser.status, 'ok');
    assert.equal(browser.backend, 'browser:test');
    assert.equal(httpFetches, 1);
    assert.equal(browserReads, 1);
    assert.deepEqual(
      memory.snapshot().attempts.map((attempt) => attempt.backend).sort(),
      ['browser:test', 'http'],
    );
  });

  it('allows the same URL/backend through a different retrieval path', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 3 });
    let fetches = 0;
    const context = {
      settings: httpSettings(),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return response(403);
      },
    };
    await resolveUrlContent('https://paths.test/page', context);
    await resolveUrlContent('https://paths.test/page', {
      ...context,
      retrievalPath: 'archive',
    });

    assert.equal(fetches, 2);
    assert.deepEqual(
      memory.snapshot().attempts.map((attempt) => attempt.retrievalPath).sort(),
      ['archive', 'direct'],
    );
  });

  it('opens a host circuit after consecutive refusals and emits no later HTTP call', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 2 });
    const events = [];
    const recordedRequests = [];
    memory.setEventSink((event) => events.push(event));
    let fetches = 0;
    const context = {
      settings: httpSettings(2),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return response(403);
      },
      recorder: {
        callStarted(record) { recordedRequests.push(record.request); },
        callFinished() {},
      },
    };

    await resolveUrlContent('https://circuit.test/one', context);
    await resolveUrlContent('https://circuit.test/two', context);
    const skipped = await resolveUrlContent('https://circuit.test/three', context);

    assert.equal(fetches, 2);
    assert.equal(recordedRequests.length, 2);
    assert.ok(recordedRequests.every((request) => request.fetchBackend === 'http'));
    assert.ok(recordedRequests.every((request) => !request.url.endsWith('/three')));
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.errorType, 'host_circuit_open');
    assert.equal(memory.snapshot().hosts['circuit.test'].open, true);
    assert.ok(events.some((event) => event.type === 'host_circuit_opened'));
    assert.ok(events.some((event) => (
      event.type === 'transport_attempt_skipped' && event.reason === 'host_circuit_open'
    )));
  });

  it('does not permanently reject a host after timeout or network failure', () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 2 });
    for (const [index, errorType] of ['timeout', 'network'].entries()) {
      const reservation = memory.begin(`https://transient.test/${index}`, { backend: 'http' });
      memory.finish(reservation, { status: 'failed', errorType, retryable: true });
    }

    assert.equal(memory.snapshot().hosts['transient.test'].open, false);
    assert.equal(memory.check('https://transient.test/next', { backend: 'http' }).allowed, true);
  });

  it('counts an explicit challenge body as a circuit refusal', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 1 });
    await resolveUrlContent('https://challenge.test/one', {
      settings: httpSettings(1),
      transportMemory: memory,
      fetchImpl: async () => response(
        200,
        '<html><body>Just a moment... checking your browser via Cloudflare.</body></html>',
      ),
    });

    assert.equal(memory.snapshot().hosts['challenge.test'].open, true);
    assert.equal(memory.snapshot().hosts['challenge.test'].lastReason, 'challenge');
  });

  it('round-trips URL attempts and open circuits through a checkpoint', () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 1 });
    const reservation = memory.begin('https://restore.test/blocked', { backend: 'http' });
    memory.finish(reservation, {
      status: 'failed',
      errorType: 'http_4xx',
      httpStatus: 403,
      fetchAttempts: 1,
    });

    const restored = new TransportMemory().restoreCheckpoint(memory.exportCheckpoint());
    assert.equal(
      restored.check('https://restore.test/blocked', { backend: 'http' }).reason,
      'url_backend_already_attempted',
    );
    assert.equal(
      restored.check('https://restore.test/other', { backend: 'http' }).reason,
      'host_circuit_open',
    );
    assert.deepEqual(restored.snapshot(), memory.snapshot());
  });
});
