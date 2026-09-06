import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { fetchUrlContent, truncateContent } from './content-fetcher.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';

/** @type {Array<(url: string, context: ContentFetchContext) => Promise<ContentFetchResult>>} */
const handlers = [];

/**
 * @typedef {Object} ContentFetchContext
 * @property {import('../types.mjs').Source} [source]
 * @property {import('../types.mjs').Settings} [settings]
 * @property {AbortSignal} [signal]
 * @property {number} [maxChars]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {Object} ContentFetchResult
 * @property {'ok'|'failed'|'unsupported'|'skipped'} status
 * @property {string} [title]
 * @property {string} [content]
 * @property {string} [error]
 * @property {string} [backend]
 */

export function registerContentFetchHandler(handler) {
  if (typeof handler === 'function') {
    handlers.unshift(handler);
  }
}

export function resetContentFetchHandlers() {
  handlers.length = 0;
}

export function getContentFetchHandlers() {
  return [...handlers];
}

export function resolveContentFetchImpl(context = {}) {
  if (typeof context.fetchImpl === 'function') return context.fetchImpl;
  return createHttpFetch(context.settings?.http?.proxy);
}

function httpFetchOptions(context = {}) {
  return {
    signal: context.signal,
    maxChars: context.maxChars,
    fetchImpl: resolveContentFetchImpl(context),
  };
}

function truncateResult(result, maxChars) {
  if (result.status !== 'ok' || !maxChars || !result.content) return result;
  if (result.content.length <= maxChars) return result;
  return {
    ...result,
    content: truncateContent(result.content, maxChars),
  };
}

/**
 * Resolve page content via registered handlers or HTTP fallback.
 *
 * @param {string} url
 * @param {ContentFetchContext} context
 * @returns {Promise<ContentFetchResult>}
 */
export async function resolveUrlContent(url, context = {}) {
  const { settings, maxChars } = context;
  const { fetchBackend } = resolveFocusedSettings(settings);

  if (fetchBackend === 'http') {
    return fetchUrlContent(url, httpFetchOptions(context));
  }

  for (const handler of handlers) {
    const result = await handler(url, context);
    if (result?.status && result.status !== 'unsupported') {
      return truncateResult(result, maxChars);
    }
  }

  if (fetchBackend === 'js-eyes') {
    return {
      status: 'failed',
      error: 'No js-eyes content handler matched URL',
    };
  }

  return fetchUrlContent(url, httpFetchOptions(context));
}
