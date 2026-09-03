const queues = new Map();
const lastCompletedAt = new Map();

export function jsEyesInvokeKey(serverUrl, skillId) {
  return `${String(serverUrl || '').trim()}::${String(skillId || 'unified').trim()}`;
}

export function resetJsEyesInvokeQueues() {
  queues.clear();
  lastCompletedAt.clear();
}

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export async function enqueueJsEyesInvoke(key, task, { signal, minIntervalMs = 0 } = {}) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (signal?.aborted) throw abortError();
    const last = lastCompletedAt.get(key) || 0;
    const wait = Math.max(0, Number(minIntervalMs) || 0) - (Date.now() - last);
    if (wait > 0) await sleep(wait, signal);
    try {
      return await task();
    } finally {
      lastCompletedAt.set(key, Date.now());
    }
  });
  queues.set(key, next.catch(() => {}));
  return next;
}

export async function waitRetryDelay(ms, signal) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return;
  await sleep(wait, signal);
}
