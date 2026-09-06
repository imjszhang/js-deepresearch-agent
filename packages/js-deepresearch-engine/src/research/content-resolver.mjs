import crypto from 'node:crypto';
import {
  createEvidenceHttpFetch,
  DEFAULT_ALLOWED_CONTENT_TYPES,
} from '../http/create-http-fetch.mjs';
import { recoverAlternateEvidence } from './alternate-evidence.mjs';
import { fetchUrlContent, truncateContent } from './content-fetcher.mjs';
import { resolveFocusedSettings } from './focused-settings.mjs';
import { isWafShellText } from './body-quality.mjs';
import {
  fetchHeadlessContent,
  isJsEyesHandlerBackend,
  isLoginPlatformHost,
  resolveReadBackends,
  shouldEscalateBackend,
} from './headless-backend.mjs';

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
  if (!context.settings?.http) return globalThis.fetch;
  return createEvidenceHttpFetch(context.settings?.http || {});
}

function httpFetchOptions(context = {}) {
  const http = context.settings?.http || {};
  const transport = context.settings?.research?.read?.transport || {};
  return {
    signal: context.signal,
    maxChars: context.maxChars,
    maxResponseBytes: http.maxResponseBytes,
    allowedContentTypes: http.allowedContentTypes || DEFAULT_ALLOWED_CONTENT_TYPES,
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

export async function runRememberedAttempt(url, context, {
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
async function runHandlers(url, context, { jsEyesOnly = false, skipJsEyes = false } = {}) {
  const { maxChars } = context;
  const retrievalPath = context.retrievalPath || 'direct';
  for (const descriptor of handlers) {
    const backend = handlerBackendId(descriptor, url, context);
    if (jsEyesOnly && !isJsEyesHandlerBackend(backend)) continue;
    if (skipJsEyes && isJsEyesHandlerBackend(backend)) continue;
    const { handler } = descriptor;
    if (typeof handler.supports === 'function' && !handler.supports(url, context)) continue;
    const result = await runRememberedAttempt(url, context, {
      backend,
      retrievalPath,
      run: () => handler(url, context),
    });
    if (result?.status && result.status !== 'unsupported') {
      return truncateResult(result, maxChars);
    }
  }
  return null;
}

async function resolveDirectUrlContent(url, context = {}) {
  const { settings } = context;
  const { fetchBackend } = resolveFocusedSettings(settings);
  const retrievalPath = context.retrievalPath || 'direct';

  if (fetchBackend === 'http') {
    return runRememberedAttempt(url, context, {
      backend: 'http',
      retrievalPath,
      run: () => fetchUrlContent(url, httpFetchOptions(context)),
    });
  }

  if (fetchBackend === 'js-eyes') {
    const handled = await runHandlers(url, context, { jsEyesOnly: true });
    if (handled) return handled;
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

  const handled = await runHandlers(url, context, { skipJsEyes: true });
  if (handled) return handled;

  if (fetchBackend === 'http' || fetchBackend === 'auto' || fetchBackend === 'headless') {
    return runRememberedAttempt(url, context, {
      backend: 'http',
      retrievalPath,
      run: () => fetchUrlContent(url, httpFetchOptions(context)),
    });
  }

  return runRememberedAttempt(url, context, {
    backend: 'http',
    retrievalPath,
    run: () => fetchUrlContent(url, httpFetchOptions(context)),
  });
}

function mergeRecovered(direct, recovered) {
  return {
    ...direct,
    ...recovered,
    httpStatus: recovered.httpStatus ?? direct.httpStatus,
    originalError: direct.error || null,
    originalErrorType: direct.errorType || null,
  };
}

export async function resolveUrlContent(url, context = {}) {
  const { fetchBackend } = resolveFocusedSettings(context.settings);
  const backends = resolveReadBackends(context.settings, fetchBackend);
  let result = await resolveDirectUrlContent(url, context);

  if (context.skipAlternateEvidence || (context.retrievalPath && context.retrievalPath !== 'direct')) {
    return result;
  }

  if (
    backends.includes('alternate')
    && context.settings?.research?.read?.alternateEvidence?.enabled !== false
    && shouldEscalateBackend(result)
  ) {
    const recovered = await recoverAlternateEvidence(url, { direct: result, context });
    if (recovered) result = mergeRecovered(result, recovered);
  }

  if (backends.includes('headless') && shouldEscalateBackend(result)) {
    const headless = await fetchHeadlessContent(url, {
      ...context,
      retrievalPath: 'headless',
    });
    if (headless && headless.status !== 'unsupported') {
      result = {
        ...result,
        ...headless,
        originalError: result.error || null,
        originalErrorType: result.errorType || null,
      };
    }
  }

  if (
    backends.includes('js-eyes')
    && fetchBackend !== 'http'
    && shouldEscalateBackend(result)
    && isLoginPlatformHost(url)
  ) {
    const eyes = await runHandlers(url, {
      ...context,
      retrievalPath: 'js-eyes',
    }, { jsEyesOnly: true });
    if (eyes) result = eyes;
  }

  return result;
}
