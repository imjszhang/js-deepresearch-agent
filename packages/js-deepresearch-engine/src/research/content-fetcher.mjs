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

function truncateContent(content, maxChars) {
  if (!maxChars || content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[...truncated]`;
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

export async function fetchUrlContent(url, {
  signal,
  maxChars = 8000,
  timeoutMs = 15000,
  convertDocument,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      const error = new Error('Research aborted');
      error.name = 'AbortError';
      throw error;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, {
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
      return {
        status: 'failed',
        error: `HTTP ${response.status}`,
      };
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
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'AbortError') {
      return {
        status: 'failed',
        error: `Timed out after ${timeoutMs}ms`,
      };
    }
    return {
      status: 'failed',
      error: error?.message || 'Fetch failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}
