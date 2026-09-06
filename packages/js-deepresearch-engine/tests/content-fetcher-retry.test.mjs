import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFetchFailure,
  fetchUrlContent,
  truncateContent,
} from '../src/research/content-fetcher.mjs';

function htmlResponse(body, extra = {}) {
  return {
    ok: extra.ok !== false,
    status: extra.status ?? 200,
    headers: {
      get(name) {
        if (name === 'content-type') return 'text/html';
        if (name === 'retry-after') return extra.retryAfter ?? null;
        return extra.headers?.[name] || null;
      },
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
    async text() {
      return body;
    },
  };
}

describe('content fetcher retry', () => {
  it('retains head, distributed body windows, and tail when bounding long content', () => {
    const source = [
      `HEAD-${'a'.repeat(1994)}`,
      `MIDDLE-ONE-${'b'.repeat(1989)}`,
      `MIDDLE-TWO-${'c'.repeat(1989)}`,
      `TAIL-${'d'.repeat(1995)}`,
    ].join('');
    const bounded = truncateContent(source, 1200);
    assert.match(bounded, /^HEAD-/);
    assert.match(bounded, /b{20}|c{20}/);
    assert.match(bounded, /d{20}$/);
    assert.match(bounded, /omitted \d+ chars/);
    assert.ok(bounded.length < 1400);
  });

  it('retries a transient network failure and then succeeds', async () => {
    let attempts = 0;
    const result = await fetchUrlContent('https://example.test/ok', {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 2) {
          const error = new TypeError('fetch failed');
          throw error;
        }
        return htmlResponse('<html><head><title>Ok</title></head><body>Hello body</body></html>');
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.fetchAttempts, 2);
    assert.match(result.content, /Hello body/);
  });

  it('does not blindly retry HTTP 4xx', async () => {
    let attempts = 0;
    const result = await fetchUrlContent('https://example.test/missing', {
      fetchImpl: async () => {
        attempts += 1;
        return htmlResponse('', { ok: false, status: 404 });
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorType, 'http_4xx');
    assert.equal(result.httpStatus, 404);
    assert.equal(result.fetchAttempts, 1);
    assert.equal(attempts, 1);
  });

  it('retries HTTP 429 and respects Retry-After', async () => {
    let attempts = 0;
    const started = Date.now();
    const result = await fetchUrlContent('https://example.test/limited', {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return htmlResponse('', { ok: false, status: 429, retryAfter: '0' });
        return htmlResponse('<html><head><title>Ok</title></head><body>Recovered</body></html>');
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(attempts, 2);
    assert.ok(Date.now() - started < 1000);
  });

  it('propagates abort immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => fetchUrlContent('https://example.test/slow', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  });

  it('retries a timeout and then succeeds', async () => {
    let attempts = 0;
    const result = await fetchUrlContent('https://example.test/slow', {
      timeoutMs: 20,
      fetchImpl: async (_url, { signal } = {}) => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const error = new Error('This operation was aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        return htmlResponse('<html><head><title>Ok</title></head><body>Recovered after timeout</body></html>');
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(attempts, 2);
    assert.equal(result.fetchAttempts, 2);
  });

  it('classifies network, timeout, and server failures as retryable', () => {
    assert.equal(classifyFetchFailure({ error: new TypeError('fetch failed') }).errorType, 'network');
    assert.equal(classifyFetchFailure({ timedOut: true }).retryable, true);
    assert.equal(classifyFetchFailure({ httpStatus: 503 }).retryable, true);
    assert.equal(classifyFetchFailure({ httpStatus: 404 }).retryable, false);
  });
});
