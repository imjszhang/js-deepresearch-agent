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

  it('does not turn a successful read into a later failure-memory skip', async () => {
    const memory = new TransportMemory();
    let fetches = 0;
    const context = {
      settings: httpSettings(),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return response(200, `<html><body>Successful immutable body ${fetches} with enough useful text.</body></html>`);
      },
    };

    const first = await resolveUrlContent('https://success.test/page', context);
    const second = await resolveUrlContent('https://success.test/page', context);

    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    assert.match(second.content, /Successful immutable body 2/);
    assert.equal(fetches, 2);
    assert.equal(memory.snapshot().attempts.length, 0);
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
      memory.snapshot().attempts.map((attempt) => attempt.backend),
      ['http'],
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

  it('counts every internal 429 attempt toward the refusal threshold', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 3 });
    let fetches = 0;
    const result = await resolveUrlContent('https://limited.test/one', {
      settings: httpSettings(3),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return {
          ...response(429),
          headers: {
            get(name) {
              if (name === 'content-type') return 'text/html';
              if (name === 'retry-after') return '0';
              return null;
            },
          },
        };
      },
    });

    assert.equal(result.fetchAttempts, 3);
    assert.equal(fetches, 3);
    assert.equal(memory.snapshot().hosts['limited.test'].consecutiveRefusals, 3);
    assert.equal(memory.snapshot().hosts['limited.test'].open, true);
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

  it('does not treat long technical prose mentioning challenge keywords as a shell', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 1 });
    let fetches = 0;
    const technicalBody = [
      'This security engineering guide explains why a forbidden response may be emitted.',
      'It compares Cloudflare controls with CAPTCHA accessibility and incident response.',
      'The remainder is ordinary technical documentation with examples and mitigations. ',
    ].join(' ').repeat(20);
    const context = {
      settings: httpSettings(1),
      transportMemory: memory,
      fetchImpl: async () => {
        fetches += 1;
        return response(200, `<html><body>${technicalBody}</body></html>`);
      },
    };

    assert.equal((await resolveUrlContent('https://docs.test/one', context)).status, 'ok');
    assert.equal((await resolveUrlContent('https://docs.test/two', context)).status, 'ok');
    assert.equal(fetches, 2);
    assert.equal(memory.snapshot().hosts['docs.test'].open, false);
  });

  it('does not persist a dynamic handler backend across resolve calls', async () => {
    const memory = new TransportMemory();
    let reads = 0;
    const dynamicHandler = async () => {
      reads += 1;
      if (reads === 1) {
        return {
          status: 'failed',
          backend: 'dynamic:first',
          error: 'first backend failed',
        };
      }
      return {
        status: 'ok',
        backend: 'dynamic:second',
        content: 'The second backend returned a complete usable body.',
      };
    };
    dynamicHandler.supports = () => true;
    dynamicHandler.backendId = () => (reads === 0 ? 'dynamic:first' : 'dynamic:second');
    registerContentFetchHandler(dynamicHandler);

    const context = {
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      transportMemory: memory,
    };
    assert.equal((await resolveUrlContent('https://dynamic.test/page', context)).status, 'failed');
    const recovered = await resolveUrlContent('https://dynamic.test/page', context);

    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.backend, 'dynamic:second');
    assert.equal(reads, 2);
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
