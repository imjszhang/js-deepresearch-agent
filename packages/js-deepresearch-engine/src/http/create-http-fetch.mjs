import {
  Agent,
  fetch as undiciFetch,
  Headers,
  ProxyAgent,
} from 'undici';
import { socksDispatcher } from 'fetch-socks';

const dispatcherCache = new Map();
const fetchCache = new Map();
let evidenceFetchCache = new WeakMap();
const evidenceResponseMetadata = new WeakMap();
const PROXY_HEADERS_TIMEOUT_MS = 900_000;
const PROXY_BODY_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 10;

export const DEFAULT_BROWSER_USER_AGENT = 'js-deepresearch-agent/1.0 (+https://github.com/imjszhang/js-deepresearch-agent)';

export const DEFAULT_ALLOWED_CONTENT_TYPES = Object.freeze([
  'text/*',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/pdf',
  'application/rtf',
  'application/epub+zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'application/vnd.ms-*',
  'application/vnd.oasis.opendocument.*',
]);

const ALLOWED_OVERRIDE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'pragma',
  'referer',
  'user-agent',
]);
const CREDENTIAL_HEADER = /(?:^|[-_])(?:api[-_]?key|authorization|cookie|credential|password|secret|session|token)(?:$|[-_])/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const COOKIE_CHALLENGE_STATUSES = new Set([403, 429]);

function agentOptions({
  http2 = false,
  maxResponseBytes = 0,
  tls,
} = {}) {
  return {
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
    bodyTimeout: PROXY_BODY_TIMEOUT_MS,
    ...(http2 ? { allowH2: true } : {}),
    ...(maxResponseBytes > 0 ? { maxResponseSize: maxResponseBytes } : {}),
    ...(tls ? { connect: tls } : {}),
  };
}

function createDispatcher(proxyUrl, options = {}) {
  const common = agentOptions(options);
  if (!proxyUrl) {
    return new Agent(common);
  }

  const parsed = new URL(proxyUrl);
  const scheme = parsed.protocol.replace(':', '');

  if (scheme === 'socks5' || scheme === 'socks5h') {
    return socksDispatcher({
      type: 5,
      host: parsed.hostname,
      port: Number(parsed.port) || 1080,
      ...(parsed.username ? { userId: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    }, common);
  }

  if (scheme === 'http' || scheme === 'https') {
    return new ProxyAgent({
      uri: proxyUrl,
      ...common,
      ...(options.http2 ? {
        requestTls: {
          ...(options.tls || {}),
          allowH2: true,
        },
      } : {}),
    });
  }

  throw new Error(`Unsupported HTTP proxy scheme "${scheme}". Use socks5://, socks5h://, http://, or https://.`);
}

function dispatcherKey(proxyUrl, options = {}) {
  return JSON.stringify({
    proxyUrl,
    http2: options.http2 === true,
    maxResponseBytes: Number(options.maxResponseBytes) || 0,
    tls: options.tls || null,
  });
}

function resolveDispatcher(proxyUrl, options) {
  const key = dispatcherKey(proxyUrl, options);
  if (dispatcherCache.has(key)) {
    return dispatcherCache.get(key);
  }

  const dispatcher = createDispatcher(proxyUrl, options);
  dispatcherCache.set(key, dispatcher);
  return dispatcher;
}

/**
 * Returns a fetch function that optionally routes through the given proxy URL.
 * Empty proxy URL with no transport options returns globalThis.fetch unchanged.
 *
 * @param {string | undefined | null} proxyUrl
 * @param {{ http2?: boolean, maxResponseBytes?: number, tls?: object }} [options]
 * @returns {typeof fetch}
 */
export function createHttpFetch(proxyUrl, options = {}) {
  const normalized = String(proxyUrl || '').trim();
  const normalizedOptions = {
    http2: options.http2 === true,
    maxResponseBytes: Math.max(0, Number(options.maxResponseBytes) || 0),
    ...(options.tls ? { tls: options.tls } : {}),
  };
  if (!normalized && !normalizedOptions.http2 && !normalizedOptions.maxResponseBytes && !normalizedOptions.tls) {
    return globalThis.fetch;
  }

  const key = dispatcherKey(normalized, normalizedOptions);
  if (fetchCache.has(key)) {
    return fetchCache.get(key);
  }

  const dispatcher = resolveDispatcher(normalized, normalizedOptions);
  const fetchFn = (input, init = {}) => undiciFetch(input, {
    ...init,
    dispatcher,
    headersTimeout: init.headersTimeout ?? PROXY_HEADERS_TIMEOUT_MS,
    bodyTimeout: init.bodyTimeout ?? PROXY_BODY_TIMEOUT_MS,
  });
  Object.defineProperty(fetchFn, 'transportOptions', {
    value: Object.freeze({
      proxy: Boolean(normalized),
      http2: normalizedOptions.http2,
      maxResponseBytes: normalizedOptions.maxResponseBytes || null,
      headersTimeoutMs: PROXY_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: PROXY_BODY_TIMEOUT_MS,
    }),
    enumerable: false,
  });
  fetchCache.set(key, fetchFn);
  return fetchFn;
}

function normalizeHeaderOverrides(hostHeaders = {}) {
  if (hostHeaders === null || hostHeaders === undefined) return {};
  if (typeof hostHeaders !== 'object' || Array.isArray(hostHeaders)) {
    throw new Error('http.hostHeaders must be an object keyed by hostname.');
  }
  const normalized = Object.create(null);
  const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
  for (const [rawHost, rawHeaders] of Object.entries(hostHeaders)) {
    const host = String(rawHost || '').trim().toLowerCase().replace(/\.$/, '');
    const hostname = host.startsWith('*.') ? host.slice(2) : host;
    if (!hostname || unsafeKeys.has(hostname) || !/^[a-z0-9.-]+$/.test(hostname)) {
      throw new Error('http.hostHeaders contains an invalid hostname key.');
    }
    if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      throw new Error('Each http.hostHeaders entry must be an object.');
    }
    normalized[host] = {};
    for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
      const name = String(rawName || '').trim().toLowerCase();
      if (!name || !ALLOWED_OVERRIDE_HEADERS.has(name) || CREDENTIAL_HEADER.test(name)) {
        throw new Error(
          'http.hostHeaders only allows User-Agent, Accept, Accept-Language, Accept-Encoding, Referer, Cache-Control, and Pragma.',
        );
      }
      if (rawValue === null || rawValue === undefined) continue;
      normalized[host][name] = String(rawValue);
    }
  }
  return normalized;
}

function overridesForHost(hostname, hostHeaders) {
  const headers = {};
  for (const [host, values] of Object.entries(hostHeaders)) {
    if (host.startsWith('*.') && hostname.endsWith(host.slice(1)) && hostname !== host.slice(2)) {
      Object.assign(headers, values);
    }
  }
  return { ...headers, ...(hostHeaders[hostname] || {}) };
}

export function buildBrowserRequestHeaders(url, {
  hostHeaders = {},
  headers,
  userAgent = DEFAULT_BROWSER_USER_AGENT,
  acceptLanguage = 'en-US,en;q=0.9',
  referer = '',
} = {}) {
  const target = new URL(url);
  const normalizedOverrides = normalizeHeaderOverrides(hostHeaders);
  const matchedOverrides = overridesForHost(target.hostname.toLowerCase(), normalizedOverrides);
  const result = new Headers({
    'user-agent': userAgent,
    accept: [
      'text/html',
      'application/xhtml+xml',
      'application/xml;q=0.9',
      'application/pdf;q=0.9',
      'text/plain;q=0.8',
      '*/*;q=0.7',
    ].join(','),
    'accept-language': acceptLanguage,
    'accept-encoding': 'gzip, deflate, br',
    ...matchedOverrides,
  });
  if (referer && !result.has('referer')) result.set('referer', referer);
  if (headers) {
    new Headers(headers).forEach((value, name) => result.set(name, value));
  }
  return result;
}

function setCookieLines(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    return headers.getSetCookie().filter(Boolean);
  }
  const combined = headers?.get?.('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,\s]+=)/).map((value) => value.trim()).filter(Boolean);
}

function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith('/') || pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function parseSetCookie(line, url) {
  const parts = String(line || '').split(';');
  const separator = parts[0].indexOf('=');
  if (separator <= 0) return null;
  const name = parts[0].slice(0, separator).trim();
  const value = parts[0].slice(separator + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null;
  const target = new URL(url);
  const cookie = {
    name,
    value,
    path: defaultCookiePath(target.pathname),
    secure: false,
    expiresAt: null,
  };
  let maxAgeSeen = false;
  for (const attribute of parts.slice(1)) {
    const [rawName, ...rawValueParts] = attribute.trim().split('=');
    const attributeName = rawName.toLowerCase();
    const attributeValue = rawValueParts.join('=').trim();
    if (attributeName === 'domain') {
      const domain = attributeValue.toLowerCase().replace(/^\./, '');
      if (domain && domain !== target.hostname.toLowerCase()) return null;
    } else if (attributeName === 'path' && attributeValue.startsWith('/')) {
      cookie.path = attributeValue;
    } else if (attributeName === 'secure') {
      cookie.secure = true;
    } else if (attributeName === 'max-age') {
      const seconds = Number(attributeValue);
      if (Number.isFinite(seconds)) {
        maxAgeSeen = true;
        cookie.expiresAt = Date.now() + (seconds * 1000);
      }
    } else if (attributeName === 'expires' && !maxAgeSeen) {
      const expiresAt = Date.parse(attributeValue);
      if (!Number.isNaN(expiresAt)) cookie.expiresAt = expiresAt;
    }
  }
  return cookie;
}

class PerHostCookieJar {
  constructor() {
    this.hosts = new Map();
  }

  store(url, headers) {
    const target = new URL(url);
    const hostname = target.hostname.toLowerCase();
    const lines = setCookieLines(headers);
    if (!lines.length) return 0;
    const cookies = this.hosts.get(hostname) || new Map();
    let changed = 0;
    for (const line of lines) {
      const cookie = parseSetCookie(line, target);
      if (!cookie) continue;
      changed += 1;
      const key = `${cookie.name}\0${cookie.path}`;
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        cookies.delete(key);
      } else {
        cookies.set(key, cookie);
      }
    }
    if (cookies.size) this.hosts.set(hostname, cookies);
    else this.hosts.delete(hostname);
    return changed;
  }

  header(url) {
    const target = new URL(url);
    const hostname = target.hostname.toLowerCase();
    const cookies = this.hosts.get(hostname);
    if (!cookies) return '';
    const values = [];
    for (const [key, cookie] of cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        cookies.delete(key);
        continue;
      }
      if (cookie.secure && target.protocol !== 'https:') continue;
      if (
        target.pathname !== cookie.path
        && !target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)
      ) continue;
      values.push(cookie);
    }
    if (!cookies.size) this.hosts.delete(hostname);
    return values
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

export function getEvidenceResponseMetadata(response) {
  return evidenceResponseMetadata.get(response) || {
    requestAttempts: 1,
    cookieRetried: false,
    redirectCount: 0,
    finalUrl: response?.url || null,
  };
}

export async function cancelResponseBody(response) {
  if (!response?.body || response.bodyUsed) return;
  try {
    const pending = response.body.cancel?.();
    if (pending && typeof pending.then === 'function') {
      await Promise.race([
        pending.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
    }
  } catch {
    // Cancellation is best effort; callers still return the original result.
  }
}

function assertHttpUrl(url, code = 'UNSUPPORTED_URL_SCHEME') {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('Evidence HTTP requests only support http: and https: URLs.');
    error.code = code;
    throw error;
  }
  return parsed;
}

function headersForOrigin(headers, { currentUrl, initialOrigin }) {
  if (new URL(currentUrl).origin !== initialOrigin) return undefined;
  return headers;
}

function redirectedMethod(status, method) {
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) return 'GET';
  return method;
}

/**
 * Browser-semantic fetch for public evidence pages. Cookies are isolated by
 * exact response hostname and settings object, and are never exposed through
 * response metadata.
 */
export function createEvidenceHttpFetch(httpSettings = {}, {
  fetchImpl,
  tls,
} = {}) {
  const configuredMaxRedirects = Number(httpSettings.maxRedirects);
  const normalized = {
    proxy: String(httpSettings.proxy || '').trim(),
    http2: httpSettings.http2 !== false,
    maxResponseBytes: Math.max(1, Number(httpSettings.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES),
    maxRedirects: Number.isInteger(configuredMaxRedirects) && configuredMaxRedirects >= 0
      ? configuredMaxRedirects
      : DEFAULT_MAX_REDIRECTS,
    cookieRetry: httpSettings.cookieRetry !== false,
    userAgent: httpSettings.userAgent || DEFAULT_BROWSER_USER_AGENT,
    acceptLanguage: httpSettings.acceptLanguage || 'en-US,en;q=0.9',
    referer: httpSettings.referer || '',
    hostHeaders: normalizeHeaderOverrides(httpSettings.hostHeaders),
  };
  const cacheable = !fetchImpl
    && !tls
    && httpSettings
    && typeof httpSettings === 'object';
  if (cacheable && evidenceFetchCache.has(httpSettings)) {
    return evidenceFetchCache.get(httpSettings);
  }

  const baseFetch = fetchImpl || createHttpFetch(normalized.proxy, {
    http2: normalized.http2,
    maxResponseBytes: normalized.maxResponseBytes,
    ...(tls ? { tls } : {}),
  });
  const cookieJar = new PerHostCookieJar();

  const fetchFn = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input : input.url;
    const initialUrl = assertHttpUrl(rawUrl).toString();
    const initialOrigin = new URL(initialUrl).origin;
    const initialHeaders = init.headers || (typeof input === 'object' ? input.headers : undefined);
    let method = String(init.method || (typeof input === 'object' ? input.method : '') || 'GET').toUpperCase();
    let body = init.body;
    let currentUrl = initialUrl;
    let redirectCount = 0;
    let requestAttempts = 0;
    let cookieRetried = false;

    while (true) {
      const headers = buildBrowserRequestHeaders(currentUrl, {
        hostHeaders: normalized.hostHeaders,
        headers: headersForOrigin(initialHeaders, { currentUrl, initialOrigin }),
        userAgent: normalized.userAgent,
        acceptLanguage: normalized.acceptLanguage,
        referer: new URL(currentUrl).origin === initialOrigin ? normalized.referer : '',
      });
      const cookie = cookieJar.header(currentUrl);
      if (cookie) {
        const existing = headers.get('cookie');
        headers.set('cookie', existing ? `${existing}; ${cookie}` : cookie);
      }
      requestAttempts += 1;
      const response = await baseFetch(currentUrl, {
        ...init,
        method,
        ...(body === undefined ? {} : { body }),
        headers,
        redirect: 'manual',
      });
      const cookiesBefore = cookieJar.header(currentUrl);
      const storedCookies = cookieJar.store(currentUrl, response.headers);
      const cookiesAfter = cookieJar.header(currentUrl);

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location) {
          evidenceResponseMetadata.set(response, {
            requestAttempts,
            cookieRetried,
            redirectCount,
            finalUrl: currentUrl,
          });
          return response;
        }
        if (redirectCount >= normalized.maxRedirects) {
          await cancelResponseBody(response);
          const error = new Error(`Redirect limit exceeded (${normalized.maxRedirects}).`);
          error.code = 'TOO_MANY_REDIRECTS';
          throw error;
        }
        const nextUrl = new URL(location, currentUrl);
        assertHttpUrl(nextUrl, 'UNSAFE_REDIRECT_SCHEME');
        await cancelResponseBody(response);
        redirectCount += 1;
        const nextMethod = redirectedMethod(response.status, method);
        if (nextMethod === 'GET' && method !== 'GET') body = undefined;
        method = nextMethod;
        currentUrl = nextUrl.toString();
        continue;
      }

      const challengeCanRetry = normalized.cookieRetry
        && !cookieRetried
        && COOKIE_CHALLENGE_STATUSES.has(response.status)
        && storedCookies > 0
        && Boolean(cookiesAfter)
        && cookiesAfter !== cookiesBefore;
      if (challengeCanRetry) {
        await cancelResponseBody(response);
        cookieRetried = true;
        continue;
      }

      evidenceResponseMetadata.set(response, {
        requestAttempts,
        cookieRetried,
        redirectCount,
        finalUrl: currentUrl,
      });
      return response;
    }
  };

  Object.defineProperty(fetchFn, 'transportOptions', {
    value: Object.freeze({
      proxy: Boolean(normalized.proxy),
      http2: normalized.http2,
      http2Fallback: 'http/1.1',
      maxResponseBytes: normalized.maxResponseBytes,
      maxRedirects: normalized.maxRedirects,
      contentDecoding: Object.freeze(['br', 'gzip', 'deflate']),
      browserHeaders: true,
      cookieRetry: normalized.cookieRetry,
    }),
    enumerable: false,
  });
  if (cacheable) evidenceFetchCache.set(httpSettings, fetchFn);
  return fetchFn;
}

export function resetHttpFetchCache() {
  for (const dispatcher of dispatcherCache.values()) {
    try {
      dispatcher.destroy?.();
    } catch {
      // Best effort for test/process teardown.
    }
  }
  dispatcherCache.clear();
  fetchCache.clear();
  evidenceFetchCache = new WeakMap();
}
