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

async function launchPlaywright(headless) {
  let playwright;
  try {
    ({ chromium: playwright } = await import('playwright'));
  } catch {
    return null;
  }
  const launch = {
    headless: true,
  };
  if (headless.proxy) launch.proxy = { server: headless.proxy };
  return playwright.launch(launch);
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

  const browser = await launchPlaywright(headless);
  if (!browser) {
    return {
      status: 'unsupported',
      backend: 'headless',
      error: 'Playwright/Chromium is not installed',
      errorType: 'backend_unavailable',
      retryable: false,
    };
  }

  let page;
  const onAbort = () => {
    page?.close?.().catch(() => {});
    browser.close().catch(() => {});
  };
  if (context.signal) {
    if (context.signal.aborted) {
      await browser.close();
      const error = new Error('Research aborted');
      error.name = 'AbortError';
      throw error;
    }
    context.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    page = await browser.newPage();
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
    if (error?.name === 'AbortError' || context.signal?.aborted) {
      const abortError = new Error('Research aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
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
    await page?.close?.().catch(() => {});
    await browser.close().catch(() => {});
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
