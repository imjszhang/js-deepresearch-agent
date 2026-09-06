import { isRawBinaryDocumentText } from './body-quality.mjs';
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
  };
}

async function sleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
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

async function readResponseBytes(response) {
  if (typeof response.arrayBuffer === 'function') {
    return new Uint8Array(await response.arrayBuffer());
  }
  const raw = await response.text();
  return new TextEncoder().encode(raw);
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function fetchUrlContentOnce(url, {
  signal,
  maxChars = 8000,
  timeoutMs = 15000,
  convertDocument,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      throw abortError();
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const accessedAt = new Date().toISOString();
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'js-deepresearch-agent/1.0 (+research)',
        accept: [
          'text/html',
          'application/xhtml+xml',
          'application/pdf;q=0.9',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.8',
          'text/plain;q=0.7',
          '*/*;q=0.5',
        ].join(','),
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      const failure = classifyFetchFailure({ httpStatus: response.status });
      return failedFetchResult({
        error: `HTTP ${response.status}`,
        ...failure,
        retryAfterMs: parseRetryAfterMs(response),
        accessedAt,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const bytes = await readResponseBytes(response);
    const format = detectDocumentFormat({ bytes, contentType, url });

    if (format) {
      const converted = await convertDocumentToMarkdown(bytes, {
        format,
        convert: convertDocument,
      });
      if (!converted.ok) {
        return {
          status: 'failed',
          error: converted.error,
          documentFormat: format,
        };
      }
      if (isRawBinaryDocumentText(converted.markdown)) {
        return {
          status: 'failed',
          error: 'Document converter returned raw file bytes',
          documentFormat: format,
        };
      }
      const content = truncateContent(
        converted.markdown,
        Math.max(Number(maxChars) || 0, DEFAULT_DOCUMENT_MAX_CHARS),
      );
      return {
        status: 'ok',
        title: extractMarkdownTitle(content) || filenameFromUrl(url) || url,
        content,
        links: [],
        converter: 'anydoc',
        documentFormat: format,
        accessedAt,
        accessStatus: 'ok',
      };
    }

    const raw = decodeText(bytes);
    if (isRawBinaryDocumentText(raw)) {
      return {
        status: 'failed',
        error: 'Binary document decoded as text',
      };
    }
    const title = extractTitle(raw) || url;
    const links = contentType.includes('html') ? extractLinks(raw, url) : [];
    let content = contentType.includes('html') ? stripHtml(raw) : raw.trim();
    content = truncateContent(content, maxChars);

    if (!content) {
      return {
        status: 'failed',
        error: 'Empty page content',
      };
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
      accessedAt,
      accessStatus: 'ok',
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
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchUrlContent(url, {
  signal,
  maxChars = 8000,
  timeoutMs = 15000,
  convertDocument,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  let lastFailure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const result = await fetchUrlContentOnce(url, {
      signal,
      maxChars,
      timeoutMs,
      convertDocument,
      fetchImpl,
    });
    if (result.status === 'ok') {
      return { ...result, fetchAttempts: attempt };
    }
    lastFailure = { ...result, fetchAttempts: attempt };
    const canRetry = result.retryable === true && attempt < attempts;
    if (!canRetry) return lastFailure;
    const delay = result.retryAfterMs ?? (250 * attempt);
    await sleep(delay, signal);
  }
  return lastFailure;
}
