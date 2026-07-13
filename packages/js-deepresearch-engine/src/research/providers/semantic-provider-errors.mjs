export class SemanticProviderError extends Error {
  constructor(message, { provider, operation, code = 'SEMANTIC_PROVIDER_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'SemanticProviderError';
    this.code = code;
    this.provider = provider;
    this.operation = operation;
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function createTimeoutSignal(signal, timeoutMs = 30000) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Semantic provider timed out after ${timeoutMs}ms`));
  }, Math.max(1, Number(timeoutMs) || 30000));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}
