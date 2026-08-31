import fs from 'node:fs';
import path from 'node:path';
import {
  convertDocumentToMarkdown,
  detectDocumentFormat,
} from 'js-deepresearch-engine';
import { TEXT_SEARCH_EXTENSIONS } from './defaults.mjs';
import { normalizeLocalSearchConfig } from './normalize-config.mjs';
import {
  extensionOf,
  isAbortError,
  isFileUrl,
  resolveSafeLocalFile,
  throwIfAborted,
} from './paths.mjs';

const DEFAULT_TEXT_MAX_CHARS = 8000;
const DEFAULT_DOCUMENT_MAX_CHARS = 32000;

function extractMarkdownTitle(markdown = '') {
  const heading = String(markdown || '').match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
}

function truncateContent(content, maxChars) {
  const text = String(content || '');
  const limit = Number(maxChars) || 0;
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[...truncated]`;
}

export function createLocalFileContentFetchHandler(options = {}) {
  const fsImpl = options.fs || fs;
  const convertDocument = options.convertDocument;

  return async function localFileContentFetchHandler(url, context = {}) {
    if (!isFileUrl(url)) {
      return { status: 'unsupported' };
    }

    const { settings, signal, maxChars } = context;
    throwIfAborted(signal);

    const local = normalizeLocalSearchConfig(settings?.search || {}).local || {};
    const roots = local.dirs || [];
    if (roots.length === 0) {
      return { status: 'failed', error: 'No corpus directories configured' };
    }

    const safe = await resolveSafeLocalFile(url, roots, fsImpl);
    if (!safe.ok) {
      return { status: 'failed', error: safe.error };
    }

    try {
      throwIfAborted(signal);
      const bytes = await fsImpl.promises.readFile(safe.path);
      const ext = extensionOf(safe.path);
      const format = detectDocumentFormat({ bytes, url });
      const titleFallback = path.basename(safe.path);

      if (TEXT_SEARCH_EXTENSIONS.includes(ext)) {
        const content = truncateContent(
          new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim(),
          Number(maxChars) || DEFAULT_TEXT_MAX_CHARS,
        );
        if (!content) {
          return { status: 'failed', error: 'Empty local file' };
        }
        return {
          status: 'ok',
          title: titleFallback,
          content,
          backend: 'local-file',
        };
      }

      if (!format) {
        return { status: 'failed', error: 'Unsupported local file type' };
      }

      const converted = await convertDocumentToMarkdown(bytes, {
        format,
        convert: convertDocument,
      });
      if (!converted.ok) {
        return { status: 'failed', error: converted.error };
      }
      const content = truncateContent(
        converted.markdown,
        Math.max(Number(maxChars) || 0, DEFAULT_DOCUMENT_MAX_CHARS),
      );
      if (!content.trim()) {
        return { status: 'failed', error: 'Empty local document' };
      }
      return {
        status: 'ok',
        title: extractMarkdownTitle(content) || titleFallback,
        content,
        backend: 'local-file',
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        status: 'failed',
        error: error?.message || 'Local file read failed',
      };
    }
  };
}

export async function fetchLocalFileContent(url, settings = {}, options = {}) {
  const handler = createLocalFileContentFetchHandler(options);
  return handler(url, {
    source: { engine: 'local' },
    settings,
    signal: options.signal,
    maxChars: options.maxChars,
  });
}
