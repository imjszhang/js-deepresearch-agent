import { resolveCompositeQuestionConcurrency } from './search-capabilities.mjs';
import {
  mergeBackendSettings,
  resolveEnabledBackends,
  resolveFanoutOptions,
  resolveSearchMaxResults,
} from './fanout-config.mjs';
import { mergeSearchResults } from './merge-search-results.mjs';

export class FanoutSearchError extends Error {
  constructor(failures) {
    const parts = failures.map((item) => `${item.id}: ${item.message}`);
    super(`All search backends failed: ${parts.join('; ')}`);
    this.name = 'FanoutSearchError';
    this.failures = failures;
  }
}

export function isSearchAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function createFanoutSearchEngine(search, instantiateEngine) {
  const enabled = resolveEnabledBackends(search);
  const fanout = resolveFanoutOptions(search, enabled.length);
  const backends = enabled.map((backend) => {
    if (backend.engine === 'composite' || backend.engine === 'fanout') {
      throw new Error(`Search backend "${backend.id}" cannot use virtual engine id "${backend.engine}".`);
    }
    const config = mergeBackendSettings(search, backend);
    const instance = instantiateEngine(backend.engine, config, backend.id);
    return {
      id: backend.id,
      engine: backend.engine,
      instance,
    };
  });

  return new CompositeSearchEngine({
    backends,
    fanout,
    maxResults: resolveSearchMaxResults(search),
  });
}

export class CompositeSearchEngine {
  constructor({ backends, fanout, maxResults }) {
    this.kind = 'composite';
    this.backends = backends;
    this.fanout = fanout;
    this.maxResults = maxResults;
    this.capabilities = {
      maxQuestionConcurrency: resolveCompositeQuestionConcurrency(
        backends.map((backend) => backend.instance),
      ),
    };
    this.budget = null;
    this.onEvent = () => {};
    this.lastDiagnostics = null;
    this.questionSlots = createSemaphore(this.capabilities.maxQuestionConcurrency);
  }

  bindBudget({ budget = null, onEvent = () => {} } = {}) {
    this.budget = budget;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    return this;
  }

  async search(query, { signal } = {}) {
    const trimmedQuery = String(query || '');
    throwIfAborted(signal);
    await this.questionSlots.acquire(signal);
    try {
      return await this.searchBackends(trimmedQuery, signal);
    } finally {
      this.questionSlots.release();
    }
  }

  async searchBackends(query, signal) {
    const outcomes = new Array(this.backends.length);
    let nextIndex = 0;
    const maxParallel = Math.min(this.fanout.maxParallelBackends, this.backends.length);

    const worker = async () => {
      while (nextIndex < this.backends.length) {
        throwIfAborted(signal);
        const index = nextIndex;
        nextIndex += 1;
        outcomes[index] = await this.runBackend(this.backends[index], query, signal);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.max(1, maxParallel) }, () => worker()));
    } catch (error) {
      if (isSearchAbortError(error)) throw error;
      throw error;
    }

    const abortOutcome = outcomes.find((outcome) => outcome?.status === 'cancelled');
    if (abortOutcome) {
      const error = new Error(abortOutcome.errorMessage || 'Research aborted');
      error.name = 'AbortError';
      throw error;
    }

    const successes = outcomes.filter((outcome) => outcome.status === 'ok');
    const failures = outcomes.filter((outcome) => outcome.status === 'failed');
    this.lastDiagnostics = {
      query,
      backends: outcomes.map(publicBackendDiagnostic),
    };

    if (successes.length === 0 && failures.length > 0) {
      throw new FanoutSearchError(failures.map((item) => ({
        id: item.backendId,
        engine: item.engine,
        name: item.errorName,
        message: item.errorMessage,
      })));
    }

    return mergeSearchResults(
      successes.map((item) => item.sources),
      this.maxResults,
    );
  }

  async runBackend(backend, query, signal) {
    const startedAt = Date.now();
    if (this.budget && !this.budget.canClaim('searchBackendRequests')) {
      const diagnostic = {
        backendId: backend.id,
        engine: backend.engine,
        status: 'skipped',
        resultCount: 0,
        durationMs: 0,
        errorName: 'BudgetExceededError',
        errorMessage: 'searchBackendRequests budget exhausted',
        sources: [],
        query,
      };
      this.emitBackend(diagnostic);
      return diagnostic;
    }
    if (this.budget) {
      this.budget.claim('searchBackendRequests');
    }

    try {
      throwIfAborted(signal);
      const sources = await backend.instance.search(query, { signal });
      const list = Array.isArray(sources) ? sources : [];
      const diagnostic = {
        backendId: backend.id,
        engine: backend.engine,
        status: 'ok',
        resultCount: list.length,
        durationMs: Date.now() - startedAt,
        errorName: null,
        errorMessage: null,
        sources: list,
        query,
      };
      this.emitBackend(diagnostic);
      return diagnostic;
    } catch (error) {
      if (isSearchAbortError(error) || signal?.aborted) {
        const diagnostic = {
          backendId: backend.id,
          engine: backend.engine,
          status: 'cancelled',
          resultCount: 0,
          durationMs: Date.now() - startedAt,
          errorName: 'AbortError',
          errorMessage: safeErrorMessage(error) || 'Research aborted',
          sources: [],
          query,
        };
        this.emitBackend(diagnostic);
        const abortError = error?.name === 'AbortError' ? error : Object.assign(new Error(diagnostic.errorMessage), { name: 'AbortError' });
        throw abortError;
      }

      const diagnostic = {
        backendId: backend.id,
        engine: backend.engine,
        status: 'failed',
        resultCount: 0,
        durationMs: Date.now() - startedAt,
        errorName: error?.name || 'Error',
        errorMessage: safeErrorMessage(error),
        sources: [],
        query,
      };
      this.emitBackend(diagnostic);
      return diagnostic;
    }
  }

  emitBackend(diagnostic) {
    this.onEvent({
      type: 'backend',
      query: diagnostic.query,
      backendId: diagnostic.backendId,
      engine: diagnostic.engine,
      status: diagnostic.status,
      resultCount: diagnostic.resultCount,
      durationMs: diagnostic.durationMs,
      errorName: diagnostic.errorName,
      errorMessage: diagnostic.errorMessage,
    });
  }
}

function publicBackendDiagnostic(diagnostic) {
  return {
    id: diagnostic.backendId,
    engine: diagnostic.engine,
    status: diagnostic.status,
    resultCount: diagnostic.resultCount,
    durationMs: diagnostic.durationMs,
    errorName: diagnostic.errorName,
    errorMessage: diagnostic.errorMessage,
  };
}

export function safeErrorMessage(error) {
  let message = String(error?.message || 'unknown error');
  message = message.replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  if (message.length > 300) {
    return `${message.slice(0, 297)}...`;
  }
  return message;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Research aborted');
  error.name = 'AbortError';
  throw error;
}

function createSemaphore(max) {
  if (max == null) {
    return {
      async acquire() {},
      release() {},
    };
  }
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  let active = 0;
  const waiters = [];
  return {
    async acquire(signal) {
      throwIfAborted(signal);
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(Object.assign(new Error('Research aborted'), { name: 'AbortError' }));
        };
        waiters.push(waiter);
        if (!signal) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) {
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },
  };
}
