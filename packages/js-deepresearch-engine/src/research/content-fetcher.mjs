import { isRawBinaryDocumentText } from './body-quality.mjs';
import {
  buildBrowserRequestHeaders,
  cancelResponseBody,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_RESPONSE_BYTES,
  getEvidenceResponseMetadata,
} from '../http/create-http-fetch.mjs';
import {
  convertDocumentToMarkdown,
  detectDocumentFormat,
  extractMarkdownTitle,
  filenameFromUrl,
} from './document-converter.mjs';

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html = '') {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractMeta(html = '', names = []) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = String(html).match(pattern);
      if (match?.[1]) return stripHtml(match[1]);
    }
  }
  return undefined;
}

function extractLinks(html = '', baseUrl = '') {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (/^https?:$/.test(url.protocol)) links.push(url.toString());
    } catch { /* ignore malformed links */ }
  }
  return [...new Set(links)];
}

const DEFAULT_DOCUMENT_MAX_CHARS = 32000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 15000;

function abortError(message = 'Research aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function parseRetryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
}

export function classifyFetchFailure({
  error = null,
  httpStatus = null,
  aborted = false,
  timedOut = false,
} = {}) {
  if (aborted) return { errorType: 'aborted', retryable: false, httpStatus };
  if (timedOut) return { errorType: 'timeout', retryable: true, httpStatus };
  if (error?.code === 'RESPONSE_TOO_LARGE' || error?.cause?.code === 'UND_ERR_RES_EXCEEDED') {
    return { errorType: 'response_too_large', retryable: false, httpStatus };
  }
  if (error?.code === 'TOO_MANY_REDIRECTS') {
    return { errorType: 'redirect_limit', retryable: false, httpStatus };
  }
  if (error?.code === 'UNSAFE_REDIRECT_SCHEME' || error?.code === 'UNSUPPORTED_URL_SCHEME') {
    return { errorType: 'unsafe_redirect', retryable: false, httpStatus };
  }
  if (httpStatus === 429) return { errorType: 'http_429', retryable: true, httpStatus };
  if (httpStatus >= 500 && httpStatus <= 599) return { errorType: 'http_5xx', retryable: true, httpStatus };
  if (httpStatus >= 400) return { errorType: 'http_4xx', retryable: false, httpStatus };
  if (error) return { errorType: 'network', retryable: true, httpStatus };
  return { errorType: 'unknown', retryable: false, httpStatus };
}

function failedFetchResult({
  error,
  errorType,
  httpStatus = null,
  attempts = 1,
  retryable = false,
  retryAfterMs = null,
  accessedAt,
  accessStatus,
  accessNotes,
  finalUrl,
  contentType,
  documentFormat,
} = {}) {
  return {
    status: 'failed',
    error,
    errorType,
    httpStatus,
    fetchAttempts: attempts,
    retryable,
    retryAfterMs,
    accessedAt,
    accessStatus: accessStatus || (httpStatus ? `http_${httpStatus}` : 'failed'),
    accessNotes: accessNotes || error,
    ...(finalUrl ? { finalUrl } : {}),
    ...(contentType ? { contentType } : {}),
    ...(documentFormat ? { documentFormat } : {}),
  };
}

async function sleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onDone, delay);
  });
}

export function truncateContent(content, maxChars) {
  if (!maxChars || content.length <= maxChars) return content;
  const windowCount = maxChars >= 1200 ? 4 : 2;
  const windowSize = Math.max(1, Math.floor(maxChars / windowCount));
  const maxStart = Math.max(0, content.length - windowSize);
  const windows = [];
  let previousEnd = 0;
  for (let index = 0; index < windowCount; index += 1) {
    const start = index === 0
      ? 0
      : (index === windowCount - 1
        ? maxStart
        : Math.round((maxStart * index) / (windowCount - 1)));
    const end = Math.min(content.length, start + windowSize);
    if (windows.length && start > previousEnd) {
      windows.push(`\n[...omitted ${start - previousEnd} chars...]\n`);
    }
    windows.push(content.slice(start, end));
    previousEnd = end;
  }
  return windows.join('');
}

function responseLimitError(maxResponseBytes) {
  const error = new Error(`Response body exceeds ${maxResponseBytes} bytes`);
  error.code = 'RESPONSE_TOO_LARGE';
  return error;
}

async function readResponseBytes(response, maxResponseBytes) {
  const limit = Math.max(1, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw responseLimitError(limit);
  }
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw responseLimitError(limit);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the original read/decompression error.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  if (typeof response.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw responseLimitError(limit);
    return bytes;
  }
  const raw = await response.text();
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > limit) throw responseLimitError(limit);
  return bytes;
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function normalizedContentType(contentType) {
  return String(contentType || '').split(';', 1)[0].trim().toLowerCase();
}

export function isAllowedContentType(contentType, allowedContentTypes = DEFAULT_ALLOWED_CONTENT_TYPES) {
  const normalized = normalizedContentType(contentType);
  if (!normalized) return false;
  const patterns = Array.isArray(allowedContentTypes)
    ? allowedContentTypes
    : DEFAULT_ALLOWED_CONTENT_TYPES;
  return patterns.some((rawPattern) => {
    const pattern = String(rawPattern || '').trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.endsWith('*')) return normalized.startsWith(pattern.slice(0, -1));
    return normalized === pattern;
  });
}

async function fetchUrlContentOnce(url, {
  signal,
  maxChars = 8000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedContentTypes = DEFAULT_ALLOWED_CONTENT_TYPES,
  timeoutMs = 15000,
  convertDocument,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  let response = null;
  let bodyConsumed = false;
  let finalUrl = url;
  let contentType = '';

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      throw abortError();
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const accessedAt = new Date().toISOString();
    response = await fetchImpl(url, {
      signal: controller.signal,
      ...(!fetchImpl.transportOptions?.browserHeaders
        ? { headers: buildBrowserRequestHeaders(url) }
        : {}),
      redirect: 'follow',
    });
    const responseMetadata = getEvidenceResponseMetadata(response);
    finalUrl = responseMetadata.finalUrl || response.url || url;
    const requestAttempts = responseMetadata.requestAttempts || 1;

    if (!response.ok) {
      const failure = classifyFetchFailure({ httpStatus: response.status });
      return failedFetchResult({
        error: `HTTP ${response.status}`,
        ...failure,
        attempts: requestAttempts,
        retryAfterMs: parseRetryAfterMs(response),
        accessedAt,
        finalUrl,
      });
    }

    contentType = response.headers.get('content-type') || '';
    const octetStream = normalizedContentType(contentType) === 'application/octet-stream';
    if (!isAllowedContentType(contentType, allowedContentTypes) && !octetStream) {
      return failedFetchResult({
        error: `Unsupported content type: ${contentType || '(missing)'}`,
        errorType: 'unsupported_content_type',
        attempts: requestAttempts,
        retryable: false,
        accessedAt,
        accessStatus: 'unsupported_content_type',
        finalUrl,
        contentType,
      });
    }
    const bytes = await readResponseBytes(response, maxResponseBytes);
    bodyConsumed = true;
    const format = detectDocumentFormat({ bytes, contentType, url: finalUrl });
    if (octetStream && !format) {
      return failedFetchResult({
        error: 'Unsupported application/octet-stream body',
        errorType: 'unsupported_content_type',
        attempts: requestAttempts,
        retryable: false,
        accessedAt,
        accessStatus: 'unsupported_content_type',
        finalUrl,
        contentType,
      });
    }

    if (format) {
      const converted = await convertDocumentToMarkdown(bytes, {
        format,
        convert: convertDocument,
      });
      if (!converted.ok) {
        return failedFetchResult({
          error: converted.error,
          errorType: 'document_conversion',
          attempts: requestAttempts,
          retryable: false,
          documentFormat: format,
          accessedAt,
          finalUrl,
          contentType,
        });
      }
      if (isRawBinaryDocumentText(converted.markdown)) {
        return failedFetchResult({
          error: 'Document converter returned raw file bytes',
          errorType: 'invalid_body',
          attempts: requestAttempts,
          retryable: false,
          documentFormat: format,
          accessedAt,
          finalUrl,
          contentType,
        });
      }
      const content = truncateContent(
        converted.markdown,
        Math.max(Number(maxChars) || 0, DEFAULT_DOCUMENT_MAX_CHARS),
      );
      return {
        status: 'ok',
        title: extractMarkdownTitle(content) || filenameFromUrl(finalUrl) || finalUrl,
        content,
        links: [],
        converter: 'anydoc',
        documentFormat: format,
        finalUrl,
        contentType,
        accessedAt,
        accessStatus: 'ok',
        requestAttempts,
      };
    }

    const raw = decodeText(bytes);
    if (isRawBinaryDocumentText(raw)) {
      return failedFetchResult({
        error: 'Binary document decoded as text',
        errorType: 'invalid_body',
        attempts: requestAttempts,
        retryable: false,
        accessedAt,
        finalUrl,
        contentType,
      });
    }
    const title = extractTitle(raw) || finalUrl;
    const links = contentType.includes('html') ? extractLinks(raw, finalUrl) : [];
    let content = contentType.includes('html') ? stripHtml(raw) : raw.trim();
    content = truncateContent(content, maxChars);

    if (!content) {
      return failedFetchResult({
        error: 'Empty page content',
        errorType: 'empty_content',
        attempts: requestAttempts,
        retryable: false,
        accessedAt,
        finalUrl,
        contentType,
      });
    }

    return {
      status: 'ok',
      title,
      content,
      links,
      publisher: extractMeta(raw, ['og:site_name', 'publisher']),
      author: extractMeta(raw, ['author', 'article:author']),
      publishedAt: extractMeta(raw, ['article:published_time', 'datePublished', 'date']),
      updatedAt: extractMeta(raw, ['article:modified_time', 'dateModified', 'last-modified'])
        || response.headers.get('last-modified')
        || undefined,
      finalUrl,
      contentType,
      accessedAt,
      accessStatus: 'ok',
      requestAttempts,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'AbortError') {
      return failedFetchResult({
        error: `Timed out after ${timeoutMs}ms`,
        ...classifyFetchFailure({ timedOut: true }),
      });
    }
    return failedFetchResult({
      error: error?.message || 'Fetch failed',
      ...classifyFetchFailure({ error }),
      finalUrl,
      contentType,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onParentAbort);
    if (response && !bodyConsumed) await cancelResponseBody(response);
  }
}

export async function fetchUrlContent(url, {
  signal,
  maxChars = 8000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedContentTypes = DEFAULT_ALLOWED_CONTENT_TYPES,
  timeoutMs = 15000,
  convertDocument,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  let lastFailure = null;
  let requestAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const result = await fetchUrlContentOnce(url, {
      signal,
      maxChars,
      maxResponseBytes,
      allowedContentTypes,
      timeoutMs,
      convertDocument,
      fetchImpl,
    });
    requestAttempts += result.requestAttempts || result.fetchAttempts || 1;
    if (result.status === 'ok') {
      const rest = { ...result };
      delete rest.requestAttempts;
      return { ...rest, fetchAttempts: requestAttempts };
    }
    lastFailure = { ...result, fetchAttempts: requestAttempts };
    const canRetry = result.retryable === true && attempt < attempts;
    if (!canRetry) return lastFailure;
    const delay = result.retryAfterMs ?? (250 * attempt);
    await sleep(delay, signal);
  }
  return lastFailure;
}
