import { fetchUrlContent } from './content-fetcher.mjs';
import { resolveSourceBasedSettings } from './source-based-settings.mjs';

/** @type {Array<(url: string, context: ContentFetchContext) => Promise<ContentFetchResult>>} */
const handlers = [];

/**
 * @typedef {Object} ContentFetchContext
 * @property {import('../types.mjs').Source} [source]
 * @property {import('../types.mjs').Settings} [settings]
 * @property {AbortSignal} [signal]
 * @property {number} [maxChars]
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

function truncateResult(result, maxChars) {
  if (result.status !== 'ok' || !maxChars || !result.content) return result;
  if (result.content.length <= maxChars) return result;
  return {
    ...result,
    content: `${result.content.slice(0, maxChars)}\n[...truncated]`,
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
  const { settings, signal, maxChars } = context;
  const { fetchBackend } = resolveSourceBasedSettings(settings);

  if (fetchBackend === 'http') {
    return fetchUrlContent(url, { signal, maxChars });
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

  return fetchUrlContent(url, { signal, maxChars });
}
