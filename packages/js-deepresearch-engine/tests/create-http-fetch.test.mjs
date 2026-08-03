import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createHttpFetch, resetHttpFetchCache } from '../src/http/create-http-fetch.mjs';

afterEach(() => {
  resetHttpFetchCache();
});

describe('createHttpFetch', () => {
  it('returns global fetch when proxy URL is empty', () => {
    const fetchFn = createHttpFetch('');
    assert.equal(fetchFn, globalThis.fetch);
  });

  it('returns global fetch when proxy URL is whitespace', () => {
    const fetchFn = createHttpFetch('   ');
    assert.equal(fetchFn, globalThis.fetch);
  });

  it('accepts socks5 proxy URLs without throwing', () => {
    assert.doesNotThrow(() => createHttpFetch('socks5://127.0.0.1:1080'));
  });

  it('accepts socks5h proxy URLs without throwing', () => {
    assert.doesNotThrow(() => createHttpFetch('socks5h://127.0.0.1:1080'));
  });

  it('accepts http proxy URLs without throwing', () => {
    assert.doesNotThrow(() => createHttpFetch('http://127.0.0.1:3128'));
  });

  it('rejects unsupported proxy schemes', () => {
    assert.throws(
      () => createHttpFetch('ftp://127.0.0.1:1080'),
      /Unsupported HTTP proxy scheme "ftp"/,
    );
  });

  it('reuses dispatcher cache for the same proxy URL', () => {
    const first = createHttpFetch('socks5://127.0.0.1:1080');
    const second = createHttpFetch('socks5://127.0.0.1:1080');
    assert.notEqual(first, globalThis.fetch);
    assert.equal(first, second);
  });
});
