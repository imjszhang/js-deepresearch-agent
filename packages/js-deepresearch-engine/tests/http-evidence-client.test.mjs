import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  buildBrowserRequestHeaders,
  createEvidenceHttpFetch,
  resetHttpFetchCache,
} from '../src/http/create-http-fetch.mjs';
import {
  fetchUrlContent,
  isAllowedContentType,
} from '../src/research/content-fetcher.mjs';

const HTML = '<html><head><title>Fixture</title></head><body>Local fixture body</body></html>';
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\n');
let server;
let baseUrl;
const hits = new Map();
const closeWaiters = new Map();

function increment(pathname) {
  hits.set(pathname, (hits.get(pathname) || 0) + 1);
}

function waitForResponseClose(pathname) {
  return new Promise((resolve) => closeWaiters.set(pathname, resolve));
}

async function closeServer(instance) {
  await new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
}

async function withTimeout(promise, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

before(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    increment(url.pathname);

    if (url.pathname === '/headers') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.headers));
      return;
    }
    if (url.pathname === '/h1') {
      response.setHeader('content-type', 'text/plain');
      response.end(`protocol=${request.httpVersion}`);
      return;
    }
    if (url.pathname === '/cookie') {
      response.setHeader('content-type', 'text/html');
      if (request.headers.cookie === 'challenge=passed') {
        response.end(HTML);
      } else {
        response.statusCode = 403;
        response.setHeader('set-cookie', 'challenge=passed; Path=/; HttpOnly; SameSite=Lax');
        response.end('retry with cookie');
      }
      return;
    }
    if (url.pathname === '/plain-403') {
      response.statusCode = 403;
      response.setHeader('content-type', 'text/html');
      response.end('forbidden');
      return;
    }
    if (url.pathname === '/unauthorized-cookie') {
      response.statusCode = 401;
      response.setHeader('content-type', 'text/plain');
      response.setHeader('set-cookie', 'login=not-allowed; Path=/');
      response.end('authentication required');
      return;
    }
    if (url.pathname === '/expired-cookie') {
      response.statusCode = 403;
      response.setHeader('content-type', 'text/html');
      response.setHeader('set-cookie', 'challenge=deleted; Max-Age=0; Path=/');
      response.end('expired cookie');
      return;
    }
    if (url.pathname === '/redirect') {
      response.statusCode = 302;
      response.setHeader('location', '/final');
      response.end();
      return;
    }
    if (url.pathname === '/cookie-redirect') {
      response.statusCode = 302;
      response.setHeader('location', '/cookie-redirect-final');
      response.setHeader('set-cookie', 'intermediate=kept; Path=/; Max-Age=60');
      response.end();
      return;
    }
    if (url.pathname === '/cookie-redirect-final') {
      response.setHeader('content-type', 'text/html');
      response.end(request.headers.cookie?.includes('intermediate=kept') ? HTML : 'missing cookie');
      return;
    }
    if (url.pathname === '/path-challenge') {
      response.setHeader('content-type', 'text/html');
      if (request.headers.cookie?.includes('id=root')) {
        response.end(HTML);
      } else {
        response.statusCode = 403;
        response.setHeader('set-cookie', [
          'id=root; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
          'id=admin; Path=/admin; Max-Age=60',
        ]);
        response.end('cookie challenge');
      }
      return;
    }
    if (url.pathname === '/admin/cookie-check') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ cookie: request.headers.cookie || '' }));
      return;
    }
    if (url.pathname === '/delete-cookie') {
      response.statusCode = 403;
      response.setHeader('content-type', 'text/plain');
      response.setHeader('set-cookie', 'id=gone; Path=/; Max-Age=0; Expires=Tue, 01 Jan 2030 00:00:00 GMT');
      response.end('delete cookie');
      return;
    }
    if (url.pathname === '/cross-redirect') {
      response.statusCode = 302;
      response.setHeader('location', `http://127.0.0.2:${url.searchParams.get('port')}/capture`);
      response.setHeader('set-cookie', 'source-cookie=private; Path=/');
      response.end();
      return;
    }
    if (url.pathname === '/unsafe-redirect') {
      response.statusCode = 302;
      response.setHeader('location', 'file:///tmp/not-allowed');
      response.end();
      return;
    }
    if (url.pathname === '/redirect-loop') {
      response.statusCode = 302;
      response.setHeader('location', '/redirect-loop');
      response.end();
      return;
    }
    if (url.pathname === '/final') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(HTML);
      return;
    }
    if (url.pathname === '/large') {
      const body = 'x'.repeat(2048);
      response.setHeader('content-type', 'text/plain');
      response.setHeader('content-length', Buffer.byteLength(body));
      response.end(body);
      return;
    }
    if (url.pathname === '/binary') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (url.pathname === '/octet-pdf') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(PDF_BYTES);
      return;
    }
    if (url.pathname === '/octet-random') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
      return;
    }
    if (url.pathname === '/streaming-403' || url.pathname === '/streaming-large') {
      response.statusCode = url.pathname === '/streaming-403' ? 403 : 200;
      response.setHeader('content-type', 'text/plain');
      response.flushHeaders();
      const timer = setInterval(() => response.write('x'.repeat(64)), 2);
      response.on('close', () => {
        clearInterval(timer);
        closeWaiters.get(url.pathname)?.();
        closeWaiters.delete(url.pathname);
      });
      return;
    }

    const compressors = {
      '/br': ['br', brotliCompressSync],
      '/gzip': ['gzip', gzipSync],
      '/deflate': ['deflate', deflateSync],
      '/gzip-bomb': ['gzip', gzipSync],
    };
    const compression = compressors[url.pathname];
    if (compression) {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-encoding', compression[0]);
      const body = url.pathname === '/gzip-bomb' ? `${HTML}${'x'.repeat(64 * 1024)}` : HTML;
      response.end(compression[1](body));
      return;
    }

    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain');
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeServer(server);
});

afterEach(() => {
  hits.clear();
  resetHttpFetchCache();
});

describe('HTTP evidence client', () => {
  it('assembles stable document headers without browser-only context claims', () => {
    const headers = buildBrowserRequestHeaders(`${baseUrl}/headers`, {
      hostHeaders: {
        '127.0.0.1': {
          Referer: 'https://search.example/results',
          'Cache-Control': 'no-cache',
        },
      },
    });
    assert.match(headers.get('user-agent'), /^js-deepresearch-agent\/1\.0/);
    assert.match(headers.get('accept'), /text\/html/);
    assert.equal(headers.get('accept-language'), 'en-US,en;q=0.9');
    assert.equal(headers.get('accept-encoding'), 'gzip, deflate, br');
    assert.equal(headers.get('referer'), 'https://search.example/results');
    assert.equal(headers.get('cache-control'), 'no-cache');
    assert.equal([...headers.keys()].some((name) => name.startsWith('sec-')), false);
    assert.equal(headers.has('upgrade-insecure-requests'), false);
  });

  it('rejects sensitive per-host header overrides', () => {
    for (const name of [
      'Authorization',
      'Cookie',
      'Proxy-Authorization',
      'X-API-Key',
      'API-Key',
      'X-Access-Token',
      'Client-Secret',
    ]) {
      assert.throws(
        () => buildBrowserRequestHeaders(`${baseUrl}/`, {
          hostHeaders: { '127.0.0.1': { [name]: 'not-echoed' } },
        }),
        /only allows/,
      );
    }
  });

  it('sends configured per-host overrides on the wire', async () => {
    const fetchImpl = createEvidenceHttpFetch({
      hostHeaders: {
        '127.0.0.1': {
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cache-Control': 'no-cache',
        },
      },
    });
    const response = await fetchImpl(`${baseUrl}/headers`);
    const received = await response.json();
    assert.equal(received['accept-language'], 'zh-CN,zh;q=0.9');
    assert.equal(received['cache-control'], 'no-cache');
  });

  it('rebuilds headers on cross-host redirects without leaking source credentials', async () => {
    let capturedHeaders;
    const target = http.createServer((request, response) => {
      capturedHeaders = request.headers;
      response.setHeader('content-type', 'text/html');
      response.end(HTML);
    });
    await new Promise((resolve) => target.listen(0, '0.0.0.0', resolve));
    try {
      const fetchImpl = createEvidenceHttpFetch({
        hostHeaders: {
          '127.0.0.1': { 'Cache-Control': 'source-only' },
          '127.0.0.2': { 'Accept-Language': 'target-only' },
        },
      });
      const response = await fetchImpl(
        `${baseUrl}/cross-redirect?port=${target.address().port}`,
        {
          headers: {
            Authorization: 'Bearer source-secret',
            Cookie: 'manual=source-secret',
            Referer: 'https://source.example/private',
            'X-Source-Only': 'source-secret',
          },
        },
      );
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(capturedHeaders.authorization, undefined);
      assert.equal(capturedHeaders.cookie, undefined);
      assert.equal(capturedHeaders.referer, undefined);
      assert.equal(capturedHeaders['x-source-only'], undefined);
      assert.equal(capturedHeaders['cache-control'], undefined);
      assert.equal(capturedHeaders['accept-language'], 'target-only');
    } finally {
      await closeServer(target);
    }
  });

  it('retries once with a host cookie only when a failed response sets one', async () => {
    const fetchImpl = createEvidenceHttpFetch({ cookieRetry: true });
    const result = await fetchUrlContent(`${baseUrl}/cookie`, { fetchImpl });
    assert.equal(result.status, 'ok');
    assert.equal(result.fetchAttempts, 2);
    assert.equal(hits.get('/cookie'), 2);
    assert.match(result.content, /Local fixture body/);
    assert.doesNotMatch(JSON.stringify(result), /challenge=passed/);
  });

  it('shares host cookies within one settings object but not across runs', async () => {
    const runSettings = { cookieRetry: true };
    const first = createEvidenceHttpFetch(runSettings);
    await fetchUrlContent(`${baseUrl}/cookie`, { fetchImpl: first });
    const afterChallenge = hits.get('/cookie');

    const sameRun = createEvidenceHttpFetch(runSettings);
    assert.equal(sameRun, first);
    await fetchUrlContent(`${baseUrl}/cookie`, { fetchImpl: sameRun });
    assert.equal(hits.get('/cookie') - afterChallenge, 1);

    const nextRun = createEvidenceHttpFetch({ cookieRetry: true });
    const beforeNextRun = hits.get('/cookie');
    await fetchUrlContent(`${baseUrl}/cookie`, { fetchImpl: nextRun });
    assert.equal(hits.get('/cookie') - beforeNextRun, 2);
  });

  it('does not blindly retry a 403 without Set-Cookie', async () => {
    const fetchImpl = createEvidenceHttpFetch({ cookieRetry: true });
    const response = await fetchImpl(`${baseUrl}/plain-403`);
    assert.equal(response.status, 403);
    assert.equal(hits.get('/plain-403'), 1);
  });

  it('never retries 401 authentication responses even when they set cookies', async () => {
    const fetchImpl = createEvidenceHttpFetch({ cookieRetry: true });
    const result = await fetchUrlContent(`${baseUrl}/unauthorized-cookie`, { fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 401);
    assert.equal(result.fetchAttempts, 1);
    assert.equal(hits.get('/unauthorized-cookie'), 1);
  });

  it('does not retry when Set-Cookie yields no usable cookie', async () => {
    const fetchImpl = createEvidenceHttpFetch({ cookieRetry: true });
    const response = await fetchImpl(`${baseUrl}/expired-cookie`);
    assert.equal(response.status, 403);
    assert.equal(hits.get('/expired-cookie'), 1);
  });

  it('allows cookie retry to be disabled by policy', async () => {
    const fetchImpl = createEvidenceHttpFetch({ cookieRetry: false });
    const response = await fetchImpl(`${baseUrl}/cookie`);
    assert.equal(response.status, 403);
    assert.equal(hits.get('/cookie'), 1);
  });

  it('collects Set-Cookie on intermediate redirects before the next hop', async () => {
    const fetchImpl = createEvidenceHttpFetch({});
    const result = await fetchUrlContent(`${baseUrl}/cookie-redirect`, { fetchImpl });
    assert.equal(result.status, 'ok');
    assert.equal(result.fetchAttempts, 2);
    assert.match(result.content, /Local fixture body/);
  });

  it('supports same-name cookies on different paths and Max-Age precedence/deletion', async () => {
    const settings = { cookieRetry: true };
    const fetchImpl = createEvidenceHttpFetch(settings);
    const challenge = await fetchUrlContent(`${baseUrl}/path-challenge`, { fetchImpl });
    assert.equal(challenge.status, 'ok');
    assert.equal(challenge.fetchAttempts, 2);

    const beforeDelete = await fetchImpl(`${baseUrl}/admin/cookie-check`);
    const beforeCookie = (await beforeDelete.json()).cookie;
    assert.match(beforeCookie, /^id=admin; id=root$/);

    const deletion = await fetchImpl(`${baseUrl}/delete-cookie`);
    assert.equal(deletion.status, 403);
    await deletion.body.cancel();

    const afterDelete = await fetchImpl(`${baseUrl}/admin/cookie-check`);
    const afterCookie = (await afterDelete.json()).cookie;
    assert.equal(afterCookie, 'id=admin');
  });

  it('falls back to HTTP/1.1 when the origin does not support HTTP/2', async () => {
    const fetchImpl = createEvidenceHttpFetch({ http2: true });
    const response = await fetchImpl(`${baseUrl}/h1`);
    assert.equal(await response.text(), 'protocol=1.1');
  });

  it('routes a real local request through an HTTP proxy', async () => {
    const seen = [];
    const proxy = http.createServer((request, response) => {
      const target = new URL(request.url);
      seen.push(target.toString());
      const headers = { ...request.headers, host: target.host };
      delete headers['proxy-authorization'];
      const upstream = http.request(target, {
        method: request.method,
        headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', (error) => response.destroy(error));
      request.pipe(upstream);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const fetchImpl = createEvidenceHttpFetch({
        proxy: `http://127.0.0.1:${proxy.address().port}`,
        http2: true,
      });
      const result = await fetchUrlContent(`${baseUrl}/final`, { fetchImpl });
      assert.equal(result.status, 'ok');
      assert.match(result.content, /Local fixture body/);
      assert.deepEqual(seen, [`${baseUrl}/final`]);
    } finally {
      resetHttpFetchCache();
      await closeServer(proxy);
    }
  });

  it('negotiates HTTP/2 through Undici ALPN and keeps HTTP/1.1 fallback enabled', async () => {
    const key = fs.readFileSync(new URL('./fixtures/http2/key.pem', import.meta.url));
    const cert = fs.readFileSync(new URL('./fixtures/http2/cert.pem', import.meta.url));
    let negotiatedVersion = null;
    let secureChallengeHits = 0;
    const h2Server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (request, response) => {
      negotiatedVersion = request.httpVersion;
      if (request.url === '/secure-cookie') {
        secureChallengeHits += 1;
        response.setHeader('content-type', 'text/html');
        if (request.headers.cookie === 'secure-challenge=passed') {
          response.end(HTML);
        } else {
          response.statusCode = 403;
          response.setHeader('set-cookie', 'secure-challenge=passed; Path=/; Secure');
          response.end('secure cookie challenge');
        }
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end(`protocol=${request.httpVersion}`);
    });
    await new Promise((resolve) => h2Server.listen(0, '127.0.0.1', resolve));
    try {
      const fetchImpl = createEvidenceHttpFetch({}, {
        // Test fixture only. Production certificate verification remains enabled.
        tls: { rejectUnauthorized: false },
      });
      const response = await fetchImpl(`https://127.0.0.1:${h2Server.address().port}/protocol`);
      assert.equal(await response.text(), 'protocol=2.0');
      assert.equal(negotiatedVersion, '2.0');
      assert.equal(fetchImpl.transportOptions.http2Fallback, 'http/1.1');
      const secure = await fetchUrlContent(
        `https://127.0.0.1:${h2Server.address().port}/secure-cookie`,
        { fetchImpl },
      );
      assert.equal(secure.status, 'ok');
      assert.equal(secureChallengeHits, 2);
    } finally {
      await new Promise((resolve, reject) => h2Server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('follows redirects and reports the final URL for citation anchoring', async () => {
    const fetchImpl = createEvidenceHttpFetch({});
    const result = await fetchUrlContent(`${baseUrl}/redirect`, { fetchImpl });
    assert.equal(result.status, 'ok');
    assert.equal(result.finalUrl, `${baseUrl}/final`);
    assert.match(result.content, /Local fixture body/);
  });

  it('rejects non-HTTP redirects and enforces the redirect limit', async () => {
    const unsafe = await fetchUrlContent(`${baseUrl}/unsafe-redirect`, {
      fetchImpl: createEvidenceHttpFetch({}),
    });
    assert.equal(unsafe.status, 'failed');
    assert.equal(unsafe.errorType, 'unsafe_redirect');

    const limited = await fetchUrlContent(`${baseUrl}/redirect-loop`, {
      fetchImpl: createEvidenceHttpFetch({ maxRedirects: 1 }),
    });
    assert.equal(limited.status, 'failed');
    assert.equal(limited.errorType, 'redirect_limit');
    assert.equal(hits.get('/redirect-loop'), 2);
  });

  for (const encoding of ['br', 'gzip', 'deflate']) {
    it(`decodes ${encoding} responses through the Undici transport`, async () => {
      const fetchImpl = createEvidenceHttpFetch({});
      const result = await fetchUrlContent(`${baseUrl}/${encoding}`, { fetchImpl });
      assert.equal(result.status, 'ok');
      assert.match(result.content, /Local fixture body/);
    });
  }

  it('enforces the decompressed size limit against a gzip bomb', async () => {
    const fetchImpl = createEvidenceHttpFetch({ maxResponseBytes: 512 });
    const result = await fetchUrlContent(`${baseUrl}/gzip-bomb`, {
      fetchImpl,
      maxResponseBytes: 512,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorType, 'response_too_large');
  });

  it('enforces the response body byte limit with a structured error type', async () => {
    const fetchImpl = createEvidenceHttpFetch({ maxResponseBytes: 64 });
    const result = await fetchUrlContent(`${baseUrl}/large`, {
      fetchImpl,
      maxResponseBytes: 64,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorType, 'response_too_large');
    assert.equal(result.retryable, false);
  });

  it('cancels indefinitely streaming HTTP/1.1 error and oversized bodies', async () => {
    for (const [pathname, options] of [
      ['/streaming-403', {}],
      ['/streaming-large', { maxResponseBytes: 96 }],
    ]) {
      const closed = waitForResponseClose(pathname);
      const fetchImpl = createEvidenceHttpFetch(options);
      const result = await fetchUrlContent(`${baseUrl}${pathname}`, {
        fetchImpl,
        ...options,
      });
      assert.equal(result.status, 'failed');
      await withTimeout(closed, `${pathname} was not cancelled`);
    }
  });

  it('cancels a streaming HTTP/2 error response', async () => {
    const key = fs.readFileSync(new URL('./fixtures/http2/key.pem', import.meta.url));
    const cert = fs.readFileSync(new URL('./fixtures/http2/cert.pem', import.meta.url));
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const h2Server = http2.createSecureServer({ key, cert });
    h2Server.on('stream', (stream) => {
      stream.respond({ ':status': 403, 'content-type': 'text/plain' });
      const timer = setInterval(() => stream.write('still streaming'), 2);
      stream.on('close', () => {
        clearInterval(timer);
        resolveClosed();
      });
    });
    await new Promise((resolve) => h2Server.listen(0, '127.0.0.1', resolve));
    try {
      const fetchImpl = createEvidenceHttpFetch({}, {
        tls: { rejectUnauthorized: false },
      });
      const result = await fetchUrlContent(
        `https://127.0.0.1:${h2Server.address().port}/streaming-403`,
        { fetchImpl },
      );
      assert.equal(result.status, 'failed');
      assert.equal(result.httpStatus, 403);
      await withTimeout(closed, 'h2 stream was not cancelled');
    } finally {
      resetHttpFetchCache();
      await closeServer(h2Server);
    }
  });

  it('rejects content outside the configured allowlist before decoding', async () => {
    const fetchImpl = createEvidenceHttpFetch({});
    const result = await fetchUrlContent(`${baseUrl}/binary`, { fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorType, 'unsupported_content_type');
    assert.equal(result.contentType, 'image/png');
    assert.equal(isAllowedContentType('text/html; charset=utf-8'), true);
    assert.equal(isAllowedContentType('image/png'), false);
  });

  it('accepts octet-stream only when document magic or a supported extension identifies it', async () => {
    const fetchImpl = createEvidenceHttpFetch({});
    const pdf = await fetchUrlContent(`${baseUrl}/octet-pdf`, {
      fetchImpl,
      convertDocument: async () => '# Fixture PDF\n\nConverted PDF evidence.',
    });
    assert.equal(pdf.status, 'ok');
    assert.equal(pdf.documentFormat, 'pdf');

    const random = await fetchUrlContent(`${baseUrl}/octet-random`, { fetchImpl });
    assert.equal(random.status, 'failed');
    assert.equal(random.errorType, 'unsupported_content_type');
  });
});
