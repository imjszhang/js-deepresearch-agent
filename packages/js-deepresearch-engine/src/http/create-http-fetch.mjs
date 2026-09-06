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

export const DEFAULT_BROWSER_USER_AGENT = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/140.0.0.0 Safari/537.36',
].join(' ');

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

const FORBIDDEN_OVERRIDE_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'connection',
  'content-length',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

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
  const normalized = {};
  for (const [rawHost, rawHeaders] of Object.entries(hostHeaders)) {
    const host = String(rawHost || '').trim().toLowerCase().replace(/\.$/, '');
    const hostname = host.startsWith('*.') ? host.slice(2) : host;
    if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) {
      throw new Error(`Invalid hostname in http.hostHeaders: ${rawHost}`);
    }
    if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      throw new Error(`http.hostHeaders["${rawHost}"] must be an object.`);
    }
    normalized[host] = {};
    for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
      const name = String(rawName || '').trim().toLowerCase();
      if (!name || FORBIDDEN_OVERRIDE_HEADERS.has(name)) {
        throw new Error(`Header "${rawName}" is not allowed in http.hostHeaders.`);
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

function secFetchSite(url, referer) {
  if (!referer) return 'none';
  try {
    return new URL(referer).origin === new URL(url).origin ? 'same-origin' : 'cross-site';
  } catch {
    return 'none';
  }
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
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': secFetchSite(url, matchedOverrides.referer || referer),
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
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
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + (seconds * 1000);
    } else if (attributeName === 'expires') {
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
    if (!lines.length) return false;
    const cookies = this.hosts.get(hostname) || new Map();
    let changed = false;
    for (const line of lines) {
      const cookie = parseSetCookie(line, target);
      if (!cookie) continue;
      changed = true;
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        cookies.delete(cookie.name);
      } else {
        cookies.set(cookie.name, cookie);
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
    for (const [name, cookie] of cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        cookies.delete(name);
        continue;
      }
      if (cookie.secure && target.protocol !== 'https:') continue;
      if (
        target.pathname !== cookie.path
        && !target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)
      ) continue;
      values.push(`${cookie.name}=${cookie.value}`);
    }
    if (!cookies.size) this.hosts.delete(hostname);
    return values.join('; ');
  }
}

export function getEvidenceResponseMetadata(response) {
  return evidenceResponseMetadata.get(response) || { requestAttempts: 1, cookieRetried: false };
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
  const normalized = {
    proxy: String(httpSettings.proxy || '').trim(),
    http2: httpSettings.http2 !== false,
    maxResponseBytes: Math.max(1, Number(httpSettings.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES),
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
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).toString();
    const request = async (url) => {
      const headers = buildBrowserRequestHeaders(url, {
        hostHeaders: normalized.hostHeaders,
        headers: init.headers,
        userAgent: normalized.userAgent,
        acceptLanguage: normalized.acceptLanguage,
        referer: normalized.referer,
      });
      const cookie = cookieJar.header(url);
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
      return baseFetch(url, {
        ...init,
        headers,
        redirect: init.redirect || 'follow',
      });
    };

    const response = await request(requestUrl);
    const responseUrl = response.url || requestUrl;
    const storedCookie = cookieJar.store(responseUrl, response.headers);
    const hasUsableCookie = storedCookie && Boolean(cookieJar.header(responseUrl));
    if (response.ok || !normalized.cookieRetry || !hasUsableCookie) {
      evidenceResponseMetadata.set(response, { requestAttempts: 1, cookieRetried: false });
      return response;
    }

    try {
      await response.body?.cancel?.();
    } catch {
      // Best effort: the retry must not be hidden by body cleanup failure.
    }
    const retried = await request(responseUrl);
    cookieJar.store(retried.url || responseUrl, retried.headers);
    evidenceResponseMetadata.set(retried, { requestAttempts: 2, cookieRetried: true });
    return retried;
  };

  Object.defineProperty(fetchFn, 'transportOptions', {
    value: Object.freeze({
      proxy: Boolean(normalized.proxy),
      http2: normalized.http2,
      http2Fallback: 'http/1.1',
      maxResponseBytes: normalized.maxResponseBytes,
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
