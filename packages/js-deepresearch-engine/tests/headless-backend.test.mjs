import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  HeadlessPool,
  closeHeadlessPool,
  fetchHeadlessContent,
  isLoginPlatformHost,
  resolveReadBackends,
} from '../src/research/headless-backend.mjs';
import {
  registerContentFetchHandler,
  resetContentFetchHandlers,
  resolveUrlContent,
} from '../src/research/content-resolver.mjs';
import { enrichFindingSources } from '../src/research/source-enricher.mjs';
import { sourceHasFetchedBody } from '../src/research/focused-settings.mjs';
import { Headers } from 'undici';

afterEach(async () => {
  resetContentFetchHandlers();
  await closeHeadlessPool();
});

function fakeBrowser({ launches = [], pages = [] } = {}) {
  return {
    async newContext() {
      return {
        async newPage() {
          const page = {
            async route() {},
            async goto() {},
            async title() { return 'Filing'; },
            async evaluate() { return 'Headless filing body recovered with enough official text for the pool.'; },
            url() { return 'https://example.com/filing'; },
            async close() { pages.push('page'); },
          };
          return page;
        },
        async close() { pages.push('context'); },
      };
    },
    async close() { launches.push('browser'); },
  };
}

describe('headless backend routing', () => {
  it('keeps js-eyes for login platforms only', () => {
    assert.equal(isLoginPlatformHost('https://zhuanlan.zhihu.com/p/1'), true);
    assert.equal(isLoginPlatformHost('https://www.reddit.com/r/x'), true);
    assert.equal(isLoginPlatformHost('https://example.com/filing'), false);
    assert.deepEqual(resolveReadBackends({}, 'auto'), ['http', 'alternate', 'headless', 'js-eyes']);
    assert.deepEqual(resolveReadBackends({}, 'http'), ['http', 'alternate']);
  });

  it('escalates a 403 HTTP page to an injected headless reader', async () => {
    const result = await resolveUrlContent('https://example.com/filing', {
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        url: 'https://example.com/filing',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('<html><body>denied</body></html>'),
      }),
      headlessFetch: async () => ({
        status: 'ok',
        title: 'Filing',
        content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
        finalUrl: 'https://example.com/filing',
      }),
      settings: {
        research: {
          focused: { fetchBackend: 'auto' },
          read: {
            alternateEvidence: { enabled: false },
            headless: { enabled: true },
          },
        },
      },
    });
    assert.equal(result.backend, 'headless');
    assert.equal(result.retrievedVia, 'headless');
    assert.match(result.content, /Official annual report/);

    const finding = await enrichFindingSources({
      question: 'What was disclosed?',
      sources: [{ url: 'https://example.com/filing', title: 'hit', snippet: 'nav' }],
    }, {
      fetchMode: 'full',
      enrichConcurrency: 1,
      maxUrlsPerIteration: 2,
      maxUrlsTotal: 2,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        url: 'https://example.com/filing',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('<html><body>denied</body></html>'),
      }),
      headlessFetch: async () => ({
        status: 'ok',
        title: 'Filing',
        content: 'Official annual report revenue and controlling shareholder disclosure with enough text.',
        finalUrl: 'https://example.com/filing',
      }),
      settings: {
        research: {
          focused: { fetchBackend: 'auto', fetchMode: 'full' },
          read: {
            alternateEvidence: { enabled: false },
            headless: { enabled: true },
          },
        },
      },
    });
    assert.equal(finding.sources[0].backend, 'headless');
    assert.equal(finding.sources[0].fetchStatus, 'ok');
    assert.equal(sourceHasFetchedBody(finding.sources[0]), true);
  });

  it('marks a challenge page blocked and does not treat it as a fetched body', async () => {
    const result = await fetchHeadlessContent('https://example.com/challenge', {
      headlessFetch: async () => ({
        status: 'ok',
        title: 'Just a moment...',
        content: 'Just a moment... Checking your browser before you access example.com.',
      }),
      settings: { research: { read: { headless: { enabled: true } } } },
    });
    assert.equal(result.accessStatus, 'blocked');
    assert.equal(result.bodyQuality, 'waf');
    assert.equal(result.content, '');
    assert.equal(sourceHasFetchedBody({
      fetchStatus: 'ok',
      content: result.content,
      bodyQuality: result.bodyQuality,
    }), false);
  });

  it('closes the injected browser when the research signal aborts', async () => {
    const closed = [];
    const controller = new AbortController();
    const pending = fetchHeadlessContent('https://example.com/slow', {
      signal: controller.signal,
      headlessFetch: async (_url, context) => {
        await new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            closed.push('page');
            closed.push('browser');
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      settings: { research: { read: { headless: { enabled: true } } } },
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.deepEqual(closed, ['page', 'browser']);
  });

  it('does not route a public host to a js-eyes handler in auto mode', async () => {
    let eyesCalls = 0;
    const handler = async () => {
      eyesCalls += 1;
      return { status: 'ok', content: 'should not run', backend: 'js-eyes:zhihu' };
    };
    handler.backendId = 'js-eyes:zhihu';
    handler.supports = () => true;
    registerContentFetchHandler(handler);

    const result = await resolveUrlContent('https://example.com/public', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://example.com/public',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode(
          '<html><head><title>Public</title></head><body>Public article body with enough characters for a successful HTTP read.</body></html>',
        ),
      }),
      settings: { research: { focused: { fetchBackend: 'auto' } } },
    });
    assert.equal(eyesCalls, 0);
    assert.notEqual(result.backend, 'js-eyes:zhihu');
    assert.match(result.content, /Public article body/);
  });

  it('does not generate a fetched body or passages when enrich sees a challenge page', async () => {
    const finding = await enrichFindingSources({
      question: 'What was disclosed?',
      sources: [{ url: 'https://example.com/challenge', title: 'hit', snippet: 'nav' }],
    }, {
      fetchMode: 'full',
      enrichConcurrency: 1,
      maxUrlsPerIteration: 2,
      maxUrlsTotal: 2,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        url: 'https://example.com/challenge',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('<html><body>Just a moment</body></html>'),
      }),
      headlessFetch: async () => ({
        status: 'ok',
        title: 'Just a moment...',
        content: 'Just a moment... Checking your browser before you access example.com.',
      }),
      settings: {
        research: {
          focused: { fetchBackend: 'auto', fetchMode: 'full' },
          read: {
            alternateEvidence: { enabled: false },
            headless: { enabled: true },
          },
        },
      },
    });
    const source = finding.sources[0];
    assert.equal(source.accessStatus, 'blocked');
    assert.equal(source.bodyQuality, 'waf');
    assert.equal(source.fetchStatus, 'failed');
    assert.equal(source.content, '');
    assert.equal(sourceHasFetchedBody(source), false);
    assert.equal((source.passages || []).length, 0);
  });

  it('reuses one browser and caps concurrent pages', async () => {
    const launches = [];
    const pool = new HeadlessPool({
      maxConcurrency: 1,
      launchImpl: async () => {
        launches.push('launch');
        return fakeBrowser({ launches });
      },
    });
    const session1 = await pool.acquire({}, {});
    const waiting = pool.acquire({}, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pool.inUse, 1);
    assert.equal(pool.waiters.length, 1);
    await session1.release();
    const session2 = await waiting;
    assert.equal(launches.filter((item) => item === 'launch').length, 1);
    assert.equal(pool.inUse, 1);
    await session2.release();
    assert.equal(pool.inUse, 0);
    await pool.close();
  });

  it('aborts a waiter without leaking a concurrency slot', async () => {
    const pool = new HeadlessPool({
      maxConcurrency: 1,
      launchImpl: async () => fakeBrowser(),
    });
    const session = await pool.acquire({}, {});
    const controller = new AbortController();
    const pending = pool.acquire({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.equal(pool.inUse, 1);
    assert.equal(pool.waiters.length, 0);
    await session.release();
    assert.equal(pool.inUse, 0);
    await pool.close();
  });
});
