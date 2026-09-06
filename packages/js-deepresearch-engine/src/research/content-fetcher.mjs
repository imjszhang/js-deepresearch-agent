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
const DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS = 10000;
const DEFAULT_HTML_TOTAL_TIMEOUT_MS = 15000;
const DEFAULT_DOCUMENT_TOTAL_TIMEOUT_MS = 60000;
const DEFAULT_LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;
const DOCUMENT_CONTENT_TYPE = /(?:application\/pdf|application\/(?:vnd\.[^;]+\+zip|msword)|officedocument|application\/rtf)/i;
const DOCUMENT_URL = /\.(?:pdf|docx?|rtf|pptx?)(?:$|[?#])/i;

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

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutPolicyFor(url, {
  timeoutMs,
  responseHeadersTimeoutMs,
  htmlTotalTimeoutMs,
  documentTotalTimeoutMs,
  largeFileThresholdBytes,
} = {}) {
  const legacyTimeout = Number(timeoutMs);
  const hasLegacyTimeout = Number.isFinite(legacyTimeout) && legacyTimeout > 0;
  return {
    responseHeadersTimeoutMs: positiveTimeout(
      responseHeadersTimeoutMs,
      hasLegacyTimeout ? legacyTimeout : DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS,
    ),
    htmlTotalTimeoutMs: positiveTimeout(
      htmlTotalTimeoutMs,
      hasLegacyTimeout ? legacyTimeout : DEFAULT_HTML_TOTAL_TIMEOUT_MS,
    ),
    documentTotalTimeoutMs: positiveTimeout(
      documentTotalTimeoutMs,
      hasLegacyTimeout ? legacyTimeout : DEFAULT_DOCUMENT_TOTAL_TIMEOUT_MS,
    ),
    largeFileThresholdBytes: positiveTimeout(
      largeFileThresholdBytes,
      DEFAULT_LARGE_FILE_THRESHOLD_BYTES,
    ),
    hintedDocument: DOCUMENT_URL.test(String(url || '')),
    boundary: 'response_headers_and_total',
    responseHeadersBoundary: 'fetch_response_headers',
  };
}

function responseTimeoutClass(response, policy) {
  const contentType = response?.headers?.get?.('content-type') || '';
  const contentLength = Number(response?.headers?.get?.('content-length')) || 0;
  const document = policy.hintedDocument
    || DOCUMENT_CONTENT_TYPE.test(contentType)
    || contentLength > policy.largeFileThresholdBytes;
  return {
    timeoutClass: document ? 'document_or_large_file' : 'html_or_text',
    totalTimeoutMs: document ? policy.documentTotalTimeoutMs : policy.htmlTotalTimeoutMs,
    contentLength: contentLength || null,
  };
}

function timeoutError(stage, timeoutMs) {
  const error = new Error(`Timed out after ${timeoutMs}ms waiting for ${stage}`);
  error.name = 'FetchTimeoutError';
  error.timeoutStage = stage;
  error.timeoutMs = timeoutMs;
  return error;
}

async function withTimeout(promise, {
  timeoutMs,
  stage,
  controller,
} = {}) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError(stage, timeoutMs));
      controller?.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function classifyFetchFailure({
  error = null,
  httpStatus = null,
  aborted = false,
  timedOut = false,
} = {}) {
  if (aborted) return { errorType: 'aborted', retryable: false, httpStatus };
  if (timedOut) return { errorType: 'timeout', retryable: true, httpStatus };
  if (httpStatus === 408) return { errorType: 'http_408', retryable: true, httpStatus };
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
  timeoutStage = null,
  timeoutPolicy = null,
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
    timeoutStage,
    timeoutPolicy,
  };
}

async function sleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delay);
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
  timeoutMs,
  responseHeadersTimeoutMs,
  htmlTotalTimeoutMs,
  documentTotalTimeoutMs,
  largeFileThresholdBytes,
  convertDocument,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const policy = timeoutPolicyFor(url, {
    timeoutMs,
    responseHeadersTimeoutMs,
    htmlTotalTimeoutMs,
    documentTotalTimeoutMs,
    largeFileThresholdBytes,
  });
  const startedAt = Date.now();
  const onAbort = () => controller.abort();
  let appliedTimeoutPolicy = {
    responseHeadersTimeoutMs: policy.responseHeadersTimeoutMs,
    totalTimeoutMs: policy.hintedDocument
      ? policy.documentTotalTimeoutMs
      : policy.htmlTotalTimeoutMs,
    timeoutClass: policy.hintedDocument ? 'document_or_large_file' : 'html_or_text',
    largeFileThresholdBytes: policy.largeFileThresholdBytes,
    boundary: policy.boundary,
    responseHeadersBoundary: policy.responseHeadersBoundary,
  };

  if (signal) {
    if (signal.aborted) {
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const accessedAt = new Date().toISOString();
    const response = await withTimeout(
      fetchImpl(url, {
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
      }),
      {
        timeoutMs: policy.responseHeadersTimeoutMs,
        stage: 'response_headers',
        controller,
      },
    );
    const timeoutClass = responseTimeoutClass(response, policy);
    const timeoutPolicy = {
      responseHeadersTimeoutMs: policy.responseHeadersTimeoutMs,
      totalTimeoutMs: timeoutClass.totalTimeoutMs,
      timeoutClass: timeoutClass.timeoutClass,
      largeFileThresholdBytes: policy.largeFileThresholdBytes,
      boundary: policy.boundary,
      responseHeadersBoundary: policy.responseHeadersBoundary,
    };
    appliedTimeoutPolicy = timeoutPolicy;

    if (!response.ok) {
      const failure = classifyFetchFailure({ httpStatus: response.status });
      return failedFetchResult({
        error: `HTTP ${response.status}`,
        ...failure,
        retryAfterMs: parseRetryAfterMs(response),
        accessedAt,
        timeoutPolicy,
      });
    }

    const remainingMs = Math.max(1, timeoutClass.totalTimeoutMs - (Date.now() - startedAt));
    return await withTimeout((async () => {
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
            errorType: 'document_conversion',
            retryable: false,
            documentFormat: format,
            timeoutPolicy,
          };
        }
        if (isRawBinaryDocumentText(converted.markdown)) {
          return {
            status: 'failed',
            error: 'Document converter returned raw file bytes',
            errorType: 'document_conversion',
            retryable: false,
            documentFormat: format,
            timeoutPolicy,
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
          timeoutPolicy,
        };
      }

      const raw = decodeText(bytes);
      if (isRawBinaryDocumentText(raw)) {
        return {
          status: 'failed',
          error: 'Binary document decoded as text',
          errorType: 'binary_content',
          retryable: false,
          timeoutPolicy,
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
          errorType: 'empty_content',
          retryable: false,
          timeoutPolicy,
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
        timeoutPolicy,
      };
    })(), {
      timeoutMs: remainingMs,
      stage: 'total',
      controller,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'FetchTimeoutError') {
      return failedFetchResult({
        error: error.message,
        ...classifyFetchFailure({ timedOut: true }),
        timeoutStage: error.timeoutStage,
        timeoutPolicy: appliedTimeoutPolicy,
      });
    }
    if (error?.name === 'AbortError') {
      return failedFetchResult({
        error: 'Fetch aborted before completion',
        ...classifyFetchFailure({ aborted: true }),
      });
    }
    return failedFetchResult({
      error: error?.message || 'Fetch failed',
      ...classifyFetchFailure({ error }),
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchUrlContent(url, {
  signal,
  maxChars = 8000,
  timeoutMs,
  responseHeadersTimeoutMs,
  htmlTotalTimeoutMs,
  documentTotalTimeoutMs,
  largeFileThresholdBytes,
  convertDocument,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  let lastFailure = null;
  const retryDelaysMs = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const result = await fetchUrlContentOnce(url, {
      signal,
      maxChars,
      timeoutMs,
      responseHeadersTimeoutMs,
      htmlTotalTimeoutMs,
      documentTotalTimeoutMs,
      largeFileThresholdBytes,
      convertDocument,
      fetchImpl,
    });
    if (result.status === 'ok') {
      return { ...result, fetchAttempts: attempt, retryDelaysMs };
    }
    lastFailure = { ...result, fetchAttempts: attempt, retryDelaysMs: [...retryDelaysMs] };
    const canRetry = result.retryable === true && attempt < attempts;
    if (!canRetry) return lastFailure;
    const delay = result.retryAfterMs ?? (250 * attempt);
    retryDelaysMs.push(delay);
    await sleepImpl(delay, signal);
  }
  return lastFailure;
}
