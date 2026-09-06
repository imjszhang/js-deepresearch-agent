import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';

const dispatcherCache = new Map();
const fetchCache = new Map();
const PROXY_HEADERS_TIMEOUT_MS = 900_000;
const PROXY_BODY_TIMEOUT_MS = 900_000;

function proxyAgentOptions() {
  return {
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
    bodyTimeout: PROXY_BODY_TIMEOUT_MS,
  };
}

function createDispatcher(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const scheme = parsed.protocol.replace(':', '');

  if (scheme === 'socks5' || scheme === 'socks5h') {
    return socksDispatcher({
      type: 5,
      host: parsed.hostname,
      port: Number(parsed.port) || 1080,
      ...(parsed.username ? { userId: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    }, proxyAgentOptions());
  }

  if (scheme === 'http' || scheme === 'https') {
    return new ProxyAgent({
      uri: proxyUrl,
      ...proxyAgentOptions(),
    });
  }

  throw new Error(`Unsupported HTTP proxy scheme "${scheme}". Use socks5://, socks5h://, http://, or https://.`);
}

function resolveDispatcher(proxyUrl) {
  if (dispatcherCache.has(proxyUrl)) {
    return dispatcherCache.get(proxyUrl);
  }

  const dispatcher = createDispatcher(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Returns a fetch function that routes through the given proxy URL.
 * Empty proxy URL returns globalThis.fetch unchanged.
 *
 * @param {string | undefined | null} proxyUrl
 * @returns {typeof fetch}
 */
export function createHttpFetch(proxyUrl) {
  const normalized = String(proxyUrl || '').trim();
  if (!normalized) {
    return globalThis.fetch;
  }

  if (fetchCache.has(normalized)) {
    return fetchCache.get(normalized);
  }

  const dispatcher = resolveDispatcher(normalized);
  const fetchFn = (input, init = {}) => undiciFetch(input, {
    ...init,
    dispatcher,
    headersTimeout: init.headersTimeout ?? PROXY_HEADERS_TIMEOUT_MS,
    bodyTimeout: init.bodyTimeout ?? PROXY_BODY_TIMEOUT_MS,
  });
  Object.defineProperty(fetchFn, 'transportOptions', {
    value: Object.freeze({
      proxy: true,
      headersTimeoutMs: PROXY_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: PROXY_BODY_TIMEOUT_MS,
    }),
    enumerable: false,
  });
  fetchCache.set(normalized, fetchFn);
  return fetchFn;
}

export function resetHttpFetchCache() {
  dispatcherCache.clear();
  fetchCache.clear();
}
