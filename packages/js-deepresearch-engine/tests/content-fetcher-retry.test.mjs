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
        if (name === 'content-length') return extra.contentLength ?? null;
        if (name === 'retry-after') return extra.retryAfter ?? null;
        return extra.headers?.[name] || null;
      },
    },
    async arrayBuffer() {
      if (extra.bodyDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, extra.bodyDelayMs));
      }
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

  it('does not retry HTTP 403 and reports exactly one fetch attempt', async () => {
    let attempts = 0;
    const result = await fetchUrlContent('https://example.test/forbidden', {
      fetchImpl: async () => {
        attempts += 1;
        return htmlResponse('', { ok: false, status: 403 });
      },
    });
    assert.equal(result.errorType, 'http_4xx');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.fetchAttempts, 1);
    assert.equal(attempts, 1);
  });

  it('retries HTTP 429 and respects Retry-After', async () => {
    let attempts = 0;
    const delays = [];
    const result = await fetchUrlContent('https://example.test/limited', {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return htmlResponse('', { ok: false, status: 429, retryAfter: '2' });
        return htmlResponse('<html><head><title>Ok</title></head><body>Recovered</body></html>');
      },
      sleepImpl: async (delay) => delays.push(delay),
    });
    assert.equal(result.status, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000]);
    assert.deepEqual(result.retryDelaysMs, [2000]);
  });

  it('retries HTTP 408 and 5xx but not an AbortError', async () => {
    for (const status of [408, 503]) {
      let attempts = 0;
      const result = await fetchUrlContent(`https://example.test/status-${status}`, {
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) return htmlResponse('', { ok: false, status });
          return htmlResponse('<html><body>Recovered from a transient server response.</body></html>');
        },
        sleepImpl: async () => {},
      });
      assert.equal(result.status, 'ok');
      assert.equal(attempts, 2);
    }

    let abortAttempts = 0;
    const aborted = await fetchUrlContent('https://example.test/abort', {
      fetchImpl: async () => {
        abortAttempts += 1;
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      sleepImpl: async () => {},
    });
    assert.equal(aborted.errorType, 'aborted');
    assert.equal(aborted.retryable, false);
    assert.equal(abortAttempts, 1);
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
    assert.equal(classifyFetchFailure({ httpStatus: 408 }).retryable, true);
    assert.equal(classifyFetchFailure({ httpStatus: 404 }).retryable, false);
  });

  it('uses independent HTML and document total-timeout boundaries', async () => {
    const fetchImpl = async () => htmlResponse(
      '<html><body>A delayed but otherwise usable response body.</body></html>',
      { bodyDelayMs: 30 },
    );
    const common = {
      fetchImpl,
      maxAttempts: 1,
      responseHeadersTimeoutMs: 10,
      htmlTotalTimeoutMs: 15,
      documentTotalTimeoutMs: 80,
      largeFileThresholdBytes: 100,
    };

    const html = await fetchUrlContent('https://example.test/page', common);
    const document = await fetchUrlContent('https://example.test/document.pdf', common);
    const large = await fetchUrlContent('https://example.test/download', {
      ...common,
      fetchImpl: async () => htmlResponse(
        '<html><body>A delayed large response body.</body></html>',
        { bodyDelayMs: 30, contentLength: '1000' },
      ),
    });

    assert.equal(html.status, 'failed');
    assert.equal(html.errorType, 'timeout');
    assert.equal(html.timeoutStage, 'total');
    assert.equal(html.timeoutPolicy.timeoutClass, 'html_or_text');
    assert.equal(document.status, 'ok');
    assert.equal(document.timeoutPolicy.timeoutClass, 'document_or_large_file');
    assert.equal(document.timeoutPolicy.totalTimeoutMs, 80);
    assert.equal(document.timeoutPolicy.responseHeadersBoundary, 'fetch_response_headers');
    assert.equal(large.status, 'ok');
    assert.equal(large.timeoutPolicy.timeoutClass, 'document_or_large_file');
  });

  it('records response-header timeout separately from total timeout', async () => {
    const result = await fetchUrlContent('https://example.test/slow-headers.pdf', {
      maxAttempts: 1,
      responseHeadersTimeoutMs: 10,
      htmlTotalTimeoutMs: 20,
      documentTotalTimeoutMs: 80,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return htmlResponse('<html><body>Late headers</body></html>');
      },
    });
    assert.equal(result.errorType, 'timeout');
    assert.equal(result.timeoutStage, 'response_headers');
    assert.equal(result.timeoutPolicy.boundary, 'response_headers_and_total');
  });
});
