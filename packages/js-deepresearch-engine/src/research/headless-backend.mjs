import { isWafShellText } from './body-quality.mjs';

export const LOGIN_PLATFORM_HOSTS = Object.freeze([
  'zhihu.com',
  'x.com',
  'twitter.com',
  'xiaohongshu.com',
  'reddit.com',
]);

const DEFAULT_BLOCKED_RESOURCE_TYPES = Object.freeze([
  'image',
  'media',
  'font',
  'stylesheet',
]);

const TRACKING_HOST_RE = /(?:^|\.)((doubleclick|googlesyndication|google-analytics|googletagmanager|adsystem|adservice|scorecardresearch|facebook|hotjar|clarity)\.)/i;

export function isLoginPlatformHost(url = '') {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return LOGIN_PLATFORM_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export function isJsEyesHandlerBackend(backendId = '') {
  return String(backendId).startsWith('js-eyes');
}

export function resolveReadBackends(settings = {}, fetchBackend = 'auto') {
  const configured = settings?.research?.read?.backends;
  if (Array.isArray(configured) && configured.length) {
    return configured.map((item) => String(item));
  }
  if (fetchBackend === 'http') return ['http', 'alternate'];
  if (fetchBackend === 'js-eyes') return ['js-eyes'];
  if (fetchBackend === 'headless') return ['http', 'alternate', 'headless'];
  return ['http', 'alternate', 'headless', 'js-eyes'];
}

export function shouldEscalateBackend(result = {}) {
  if (!result || result.transportMemorySkipped) return false;
  if (result.status === 'ok' && result.evidenceRole !== 'metadata' && !isWafShellText(result.content)) {
    return String(result.content || '').trim().length < 80;
  }
  return result.status !== 'ok' || result.evidenceRole === 'metadata' || isWafShellText(result.content);
}

function resolveHeadlessSettings(settings = {}) {
  const raw = settings?.research?.read?.headless || {};
  return {
    enabled: raw.enabled === true,
    waitUntil: raw.waitUntil || 'domcontentloaded',
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 15000,
    maxConcurrency: Number(raw.maxConcurrency) > 0 ? Number(raw.maxConcurrency) : 2,
    proxy: raw.proxy || settings?.http?.proxy || '',
  };
}

function blockedResult(content, extra = {}) {
  return {
    status: 'failed',
    backend: 'headless',
    retrievedVia: 'headless',
    accessStatus: 'blocked',
    bodyQuality: 'waf',
    errorType: 'challenge',
    error: 'Headless navigation hit a challenge or access-denied page',
    content: '',
    previewHtml: content,
    retryable: false,
    ...extra,
  };
}

async function launchPlaywright(headless = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }
  try {
    const launch = { headless: true };
    if (headless.proxy) launch.proxy = { server: headless.proxy };
    return await chromium.launch(launch);
  } catch {
    return null;
  }
}

function abortError(message = 'Research aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class HeadlessPool {
  constructor({
    maxConcurrency = 2,
    launchImpl = launchPlaywright,
  } = {}) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 2);
    this.launchImpl = launchImpl;
    this.browser = null;
    this.launching = null;
    this.inUse = 0;
    this.waiters = [];
    this.closed = false;
  }

  async #browser(headless) {
    if (this.closed) throw abortError('Headless pool closed');
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = Promise.resolve()
        .then(() => this.launchImpl(headless))
        .then((browser) => {
          this.browser = browser;
          this.launching = null;
          return browser;
        })
        .catch((error) => {
          this.launching = null;
          throw error;
        });
    }
    return this.launching;
  }

  #waitForSlot(signal) {
    if (this.inUse < this.maxConcurrency) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.resolve = (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
      }
      this.waiters.push(waiter);
    }).then(() => {
      this.inUse += 1;
    });
  }

  #releaseSlot() {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.waiters.shift();
    next?.resolve();
  }

  async acquire(headless = {}, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const browser = await this.#browser(headless);
    if (!browser) return null;
    await this.#waitForSlot(signal);
    if (this.closed || signal?.aborted) {
      this.#releaseSlot();
      throw abortError();
    }
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      return {
        browser,
        context,
        page,
        release: async () => {
          await page.close?.().catch(() => {});
          await context.close?.().catch(() => {});
          this.#releaseSlot();
        },
      };
    } catch (error) {
      this.#releaseSlot();
      throw error;
    }
  }

  async close() {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(abortError('Headless pool closed'));
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    this.inUse = 0;
    if (browser) await browser.close?.().catch(() => {});
  }
}

let sharedPool = null;

export function getSharedHeadlessPool(headless = {}) {
  if (!sharedPool || sharedPool.closed) {
    sharedPool = new HeadlessPool({ maxConcurrency: headless.maxConcurrency });
    return sharedPool;
  }
  if (Number(headless.maxConcurrency) > 0) {
    sharedPool.maxConcurrency = Number(headless.maxConcurrency);
  }
  return sharedPool;
}

export async function closeHeadlessPool() {
  const pool = sharedPool;
  sharedPool = null;
  if (pool) await pool.close();
}

export async function fetchHeadlessContent(url, context = {}) {
  const headless = resolveHeadlessSettings(context.settings);
  const injected = context.headlessFetch || headless.fetchImpl;
  if (typeof injected === 'function') {
    const result = await injected(url, { ...context, headless });
    return decorateHeadlessResult(result, url);
  }
  if (headless.enabled !== true) {
    return { status: 'unsupported', backend: 'headless', error: 'Headless backend disabled' };
  }

  const pool = context.headlessPool || getSharedHeadlessPool(headless);
  let session;
  const onAbort = () => {
    session?.page?.close?.().catch(() => {});
  };
  if (context.signal) {
    if (context.signal.aborted) throw abortError();
    context.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    session = await pool.acquire(headless, { signal: context.signal });
    if (!session) {
      return {
        status: 'unsupported',
        backend: 'headless',
        error: 'Playwright/Chromium is not installed',
        errorType: 'backend_unavailable',
        retryable: false,
      };
    }
    const { page } = session;
    await page.route('**/*', (route) => {
      const request = route.request();
      const type = request.resourceType();
      const reqUrl = request.url();
      if (DEFAULT_BLOCKED_RESOURCE_TYPES.includes(type) || TRACKING_HOST_RE.test(reqUrl)) {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, {
      waitUntil: headless.waitUntil,
      timeout: headless.timeoutMs,
    });
    const title = await page.title();
    const content = await page.evaluate(() => {
      const root = document.querySelector('article, [role="article"], main, [role="main"]') || document.body;
      return (root?.innerText || '').trim();
    });
    const finalUrl = page.url();
    return decorateHeadlessResult({
      status: 'ok',
      title,
      content,
      finalUrl,
      backend: 'headless',
      retrievedVia: 'headless',
    }, url);
  } catch (error) {
    if (error?.name === 'AbortError' || context.signal?.aborted) throw abortError();
    return {
      status: 'failed',
      backend: 'headless',
      retrievedVia: 'headless',
      error: error.message,
      errorType: 'network',
      retryable: true,
    };
  } finally {
    context.signal?.removeEventListener?.('abort', onAbort);
    await session?.release?.();
  }
}

export function decorateHeadlessResult(result = {}, url = '') {
  if (!result || result.status === 'unsupported') {
    return { status: 'unsupported', backend: 'headless', ...result };
  }
  if (result.status === 'blocked' || result.accessStatus === 'blocked' || isWafShellText(result.content)) {
    return blockedResult(result.content, {
      title: result.title,
      finalUrl: result.finalUrl || url,
      retrievedAt: new Date().toISOString(),
    });
  }
  return {
    ...result,
    status: result.status || 'ok',
    backend: 'headless',
    retrievedVia: result.retrievedVia || 'headless',
    retrievedAt: result.retrievedAt || new Date().toISOString(),
    evidenceRole: result.evidenceRole || 'body',
  };
}
