import crypto from 'node:crypto';
import { createHttpFetch } from '../http/create-http-fetch.mjs';
import { fetchUrlContent, truncateContent } from './content-fetcher.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { isWafShellText } from './body-quality.mjs';

/** @type {Array<{handler: Function, backendId: string|Function|null}>} */
const handlers = [];

/**
 * @typedef {Object} ContentFetchContext
 * @property {import('../types.mjs').Source} [source]
 * @property {import('../types.mjs').Settings} [settings]
 * @property {AbortSignal} [signal]
 * @property {number} [maxChars]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('./transport-memory.mjs').TransportMemory} [transportMemory]
 * @property {Object} [recorder]
 * @property {string} [retrievalPath]
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
    handlers.unshift({
      handler,
      backendId: handler.backendId || null,
    });
  }
}

export function resetContentFetchHandlers() {
  handlers.length = 0;
}

export function getContentFetchHandlers() {
  return handlers.map((entry) => entry.handler);
}

export function resolveContentFetchImpl(context = {}) {
  if (typeof context.fetchImpl === 'function') return context.fetchImpl;
  return createHttpFetch(context.settings?.http?.proxy);
}

function httpFetchOptions(context = {}) {
  const transport = context.settings?.research?.read?.transport || {};
  return {
    signal: context.signal,
    maxChars: context.maxChars,
    fetchImpl: resolveContentFetchImpl(context),
    maxAttempts: transport.maxAttempts,
    responseHeadersTimeoutMs: transport.responseHeadersTimeoutMs,
    htmlTotalTimeoutMs: transport.htmlTotalTimeoutMs,
    documentTotalTimeoutMs: transport.documentTotalTimeoutMs,
    largeFileThresholdBytes: transport.largeFileThresholdBytes,
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

function handlerBackendId(descriptor, url, context) {
  const configured = typeof descriptor.backendId === 'function'
    ? descriptor.backendId(url, context)
    : descriptor.backendId;
  return String(configured || `handler:${descriptor.handler.name || 'anonymous'}`);
}

function memoryOutcome(result = {}) {
  if (result.status === 'ok' && isWafShellText(result.content)) {
    return {
      ...result,
      status: 'failed',
      errorType: 'challenge',
      retryable: false,
      challenge: true,
    };
  }
  return result;
}

async function runRememberedAttempt(url, context, {
  backend,
  retrievalPath = 'direct',
  run,
} = {}) {
  const memory = context.transportMemory;
  const execute = async () => {
    const callId = `fetch-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    context.recorder?.callStarted?.({
      callId,
      kind: 'content-fetch',
      request: {
        url,
        sourceId: context.source?.id || null,
        maxChars: context.maxChars,
        fetchBackend: backend,
        requestedFetchBackend: resolveFocusedSettings(context.settings).fetchBackend,
        retrievalPath,
        viaProxy: Boolean(String(context.settings?.http?.proxy || '').trim()),
      },
    });
    try {
      const rawResult = await run();
      const result = {
        ...rawResult,
        backend: rawResult?.backend || backend,
        retrievalPath: rawResult?.retrievalPath || retrievalPath,
      };
      context.recorder?.callFinished?.({
        callId,
        kind: 'content-fetch',
        status: result?.status === 'ok'
          ? 'completed'
          : (result?.status === 'unsupported' ? 'skipped' : 'failed'),
        response: result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      context.recorder?.callFinished?.({
        callId,
        kind: 'content-fetch',
        status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
        error,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  };
  if (!memory) {
    const result = await execute();
    return {
      ...result,
      backend: result?.backend || backend,
      retrievalPath: result?.retrievalPath || retrievalPath,
    };
  }
  const reservation = memory.begin(url, { backend, retrievalPath });
  if (!reservation.allowed) return memory.skippedResult(reservation);
  try {
    const result = await execute();
    if (result?.status === 'unsupported') {
      memory.cancel(reservation);
      return result;
    }
    const resolvedBackend = result?.backend || backend;
    if (resolvedBackend !== backend) {
      memory.cancel(reservation);
      const resolvedReservation = memory.begin(url, {
        backend: resolvedBackend,
        retrievalPath: result?.retrievalPath || retrievalPath,
      });
      if (resolvedReservation.allowed) memory.finish(resolvedReservation, memoryOutcome(result));
    } else {
      memory.finish(reservation, memoryOutcome(result));
    }
    return {
      ...result,
      backend: resolvedBackend,
      retrievalPath: result?.retrievalPath || retrievalPath,
    };
  } catch (error) {
    memory.finish(reservation, {
      status: 'failed',
      errorType: error?.name === 'AbortError' ? 'aborted' : 'network',
      retryable: error?.name !== 'AbortError',
    });
    throw error;
  }
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
  const retrievalPath = context.retrievalPath || 'direct';

  if (fetchBackend === 'http') {
    return runRememberedAttempt(url, context, {
      backend: 'http',
      retrievalPath,
      run: () => fetchUrlContent(url, httpFetchOptions(context)),
    });
  }

  for (const descriptor of handlers) {
    const { handler } = descriptor;
    if (typeof handler.supports === 'function' && !handler.supports(url, context)) continue;
    const backend = handlerBackendId(descriptor, url, context);
    const result = await runRememberedAttempt(url, context, {
      backend,
      retrievalPath,
      run: () => handler(url, context),
    });
    if (result?.status && result.status !== 'unsupported') {
      return truncateResult(result, maxChars);
    }
  }

  if (fetchBackend === 'js-eyes') {
    return runRememberedAttempt(url, context, {
      backend: 'js-eyes',
      retrievalPath,
      run: async () => ({
        status: 'failed',
        error: 'No js-eyes content handler matched URL',
        errorType: 'backend_unavailable',
        retryable: false,
      }),
    });
  }

  return runRememberedAttempt(url, context, {
    backend: 'http',
    retrievalPath,
    run: () => fetchUrlContent(url, httpFetchOptions(context)),
  });
}
