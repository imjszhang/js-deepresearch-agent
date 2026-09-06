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
let server;
let baseUrl;
const hits = new Map();

function increment(pathname) {
  hits.set(pathname, (hits.get(pathname) || 0) + 1);
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

    const compressors = {
      '/br': ['br', brotliCompressSync],
      '/gzip': ['gzip', gzipSync],
      '/deflate': ['deflate', deflateSync],
    };
    const compression = compressors[url.pathname];
    if (compression) {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-encoding', compression[0]);
      response.end(compression[1](HTML));
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

afterEach(() => {
  hits.clear();
  resetHttpFetchCache();
});

describe('HTTP evidence client', () => {
  it('assembles browser navigation headers and applies exact host overrides', () => {
    const headers = buildBrowserRequestHeaders(`${baseUrl}/headers`, {
      hostHeaders: {
        '127.0.0.1': {
          Referer: 'https://search.example/results',
          'X-Fixture': 'enabled',
        },
      },
    });
    assert.match(headers.get('user-agent'), /^Mozilla\/5\.0/);
    assert.match(headers.get('accept'), /text\/html/);
    assert.equal(headers.get('accept-language'), 'en-US,en;q=0.9');
    assert.equal(headers.get('accept-encoding'), 'gzip, deflate, br');
    assert.equal(headers.get('sec-fetch-dest'), 'document');
    assert.equal(headers.get('sec-fetch-mode'), 'navigate');
    assert.equal(headers.get('sec-fetch-site'), 'cross-site');
    assert.equal(headers.get('sec-fetch-user'), '?1');
    assert.equal(headers.get('upgrade-insecure-requests'), '1');
    assert.equal(headers.get('x-fixture'), 'enabled');
  });

  it('rejects sensitive per-host header overrides', () => {
    assert.throws(
      () => buildBrowserRequestHeaders(`${baseUrl}/`, {
        hostHeaders: { '127.0.0.1': { Cookie: 'session=secret' } },
      }),
      /not allowed/,
    );
  });

  it('sends configured per-host overrides on the wire', async () => {
    const fetchImpl = createEvidenceHttpFetch({
      hostHeaders: {
        '127.0.0.1': {
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'X-Fixture': 'enabled',
        },
      },
    });
    const response = await fetchImpl(`${baseUrl}/headers`);
    const received = await response.json();
    assert.equal(received['accept-language'], 'zh-CN,zh;q=0.9');
    assert.equal(received['x-fixture'], 'enabled');
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

  it('negotiates HTTP/2 through Undici ALPN and keeps HTTP/1.1 fallback enabled', async () => {
    const key = fs.readFileSync(new URL('./fixtures/http2/key.pem', import.meta.url));
    const cert = fs.readFileSync(new URL('./fixtures/http2/cert.pem', import.meta.url));
    let negotiatedVersion = null;
    const h2Server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (request, response) => {
      negotiatedVersion = request.httpVersion;
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

  for (const encoding of ['br', 'gzip', 'deflate']) {
    it(`decodes ${encoding} responses through the Undici transport`, async () => {
      const fetchImpl = createEvidenceHttpFetch({});
      const result = await fetchUrlContent(`${baseUrl}/${encoding}`, { fetchImpl });
      assert.equal(result.status, 'ok');
      assert.match(result.content, /Local fixture body/);
    });
  }

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

  it('rejects content outside the configured allowlist before decoding', async () => {
    const fetchImpl = createEvidenceHttpFetch({});
    const result = await fetchUrlContent(`${baseUrl}/binary`, { fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorType, 'unsupported_content_type');
    assert.equal(result.contentType, 'image/png');
    assert.equal(isAllowedContentType('text/html; charset=utf-8'), true);
    assert.equal(isAllowedContentType('image/png'), false);
  });
});
