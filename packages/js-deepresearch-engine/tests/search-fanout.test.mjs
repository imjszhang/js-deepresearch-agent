import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BudgetManager,
  createSearchEngine,
  FanoutSearchError,
  mergeSearchResults,
  registerSearchEngine,
  resetEngineRegistries,
  resolveSearchConcurrency,
  resolveSearchMode,
  searchEngineMetadata,
  wrapProvidersWithBudget,
} from '../src/index.mjs';

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function source(title, url, extra = {}) {
  return { title, url, snippet: extra.snippet ?? title, engine: extra.engine, ...extra };
}

describe('search fan-out', () => {
  afterEach(() => {
    resetEngineRegistries();
  });

  it('keeps the legacy single-engine factory path', () => {
    const engine = createSearchEngine({
      search: { engine: 'searxng', baseUrl: 'http://legacy.local:8080' },
    });
    assert.equal(engine.kind, undefined);
    assert.equal(engine.id, 'searxng');
    assert.equal(engine.config.baseUrl, 'http://legacy.local:8080');
    assert.equal(resolveSearchMode({ engine: 'searxng' }), 'single');
    assert.equal(searchEngineMetadata.some((entry) => entry.id === 'composite'), false);
  });

  it('creates isolated backend instances with per-backend settings', async () => {
    const seen = {};
    registerSearchEngine('mock-a', {
      create: (config) => {
        seen.a = config;
        return {
          capabilities: { maxQuestionConcurrency: 3 },
          async search() { return [source('A', 'https://a.test/1', { engine: 'mock-a' })]; },
        };
      },
    });
    registerSearchEngine('mock-b', {
      create: (config) => {
        seen.b = config;
        return {
          capabilities: { maxQuestionConcurrency: 1 },
          async search() { return [source('B', 'https://b.test/1', { engine: 'mock-b' })]; },
        };
      },
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        maxResults: 10,
        baseUrl: 'http://shared.local',
        backends: [
          { id: 'web', engine: 'mock-a', enabled: true, settings: { maxResults: 4, baseUrl: 'http://a.local' } },
          { id: 'community', engine: 'mock-b', enabled: true, settings: { maxResults: 6 } },
        ],
        fanout: { failurePolicy: 'partial', merge: 'round-robin', maxParallelBackends: 2 },
      },
    });

    assert.equal(engine.kind, 'composite');
    assert.equal(engine.backends.length, 2);
    assert.equal(seen.a.baseUrl, 'http://a.local');
    assert.equal(seen.a.maxResults, 4);
    assert.equal(seen.b.baseUrl, 'http://shared.local');
    assert.equal(seen.b.maxResults, 6);
    assert.equal(engine.capabilities.maxQuestionConcurrency, 1);
    assert.equal(resolveSearchConcurrency(engine, { research: { concurrency: 4 } }, 4), 1);

    const results = await engine.search('topic');
    assert.deepEqual(results.map((item) => item.engine), ['mock-a', 'mock-b']);
  });

  it('rejects invalid fan-out configuration with locatable errors', () => {
    assert.throws(
      () => createSearchEngine({ search: { mode: 'fanout', backends: [] } }),
      /at least one enabled backend/,
    );
    assert.throws(
      () => createSearchEngine({
        search: {
          mode: 'fanout',
          backends: [
            { id: 'web', engine: 'searxng' },
            { id: 'web', engine: 'searxng' },
          ],
        },
      }),
      /Duplicate search backend id: "web"/,
    );
    assert.throws(
      () => createSearchEngine({
        search: { mode: 'fanout', backends: [{ id: 'x', engine: 'not-registered' }] },
      }),
      /Unknown search backend engine "not-registered" for backend "x"/,
    );
    assert.throws(
      () => createSearchEngine({
        search: {
          mode: 'fanout',
          backends: [{ id: 'web', engine: 'searxng' }],
          fanout: { maxParallelBackends: -1 },
        },
      }),
      /maxParallelBackends/,
    );
    assert.throws(
      () => createSearchEngine({ search: { mode: 'cluster' } }),
      /Invalid search.mode/,
    );
  });

  it('runs enabled backends concurrently and records overlapping work', async () => {
    let active = 0;
    let maxActive = 0;
    const startedAt = [];
    const finishedAt = [];

    function delayedEngine(id, waitMs) {
      registerSearchEngine(id, {
        create: () => ({
          async search() {
            startedAt.push(Date.now());
            active += 1;
            maxActive = Math.max(maxActive, active);
            await delay(waitMs);
            active -= 1;
            finishedAt.push(Date.now());
            return [source(id, `https://${id}.test`, { engine: id })];
          },
        }),
      });
    }

    delayedEngine('mock-a', 60);
    delayedEngine('mock-b', 60);

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'a', engine: 'mock-a' },
          { id: 'b', engine: 'mock-b' },
        ],
        fanout: { maxParallelBackends: 2 },
      },
    });

    const started = Date.now();
    await engine.search('overlap');
    const elapsed = Date.now() - started;

    assert.equal(maxActive, 2);
    assert.ok(startedAt[0] < finishedAt[1] && startedAt[1] < finishedAt[0]);
    assert.ok(elapsed < 110);
  });

  it('merges results with deterministic round-robin, URL dedupe, and snippet-only keep', () => {
    const merged = mergeSearchResults([
      [
        source('A1', 'https://example.com/x?utm_source=a', { engine: 'mock-a' }),
        source('A2', 'https://a.test/2', { engine: 'mock-a' }),
        { title: 'Snippet only', url: '', snippet: 'no url but useful', engine: 'mock-a' },
      ],
      [
        source('B1', 'https://example.com/x#frag', { engine: 'mock-b' }),
        source('B2', 'https://b.test/2', { engine: 'mock-b' }),
      ],
    ], 10);

    assert.deepEqual(merged.map((item) => item.title), ['A1', 'B2', 'A2', 'Snippet only']);
    assert.equal(merged.some((item) => item.title === 'B1'), false);
    assert.equal(merged.find((item) => item.title === 'Snippet only').url, '');
  });

  it('applies the top-level maxResults cap after merge', async () => {
    registerSearchEngine('mock-a', {
      create: () => ({
        async search() {
          return [1, 2, 3].map((index) => source(`A${index}`, `https://a.test/${index}`, { engine: 'mock-a' }));
        },
      }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({
        async search() {
          return [1, 2, 3].map((index) => source(`B${index}`, `https://b.test/${index}`, { engine: 'mock-b' }));
        },
      }),
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        maxResults: 3,
        backends: [
          { id: 'a', engine: 'mock-a' },
          { id: 'b', engine: 'mock-b' },
        ],
      },
    });

    const results = await engine.search('cap');
    assert.deepEqual(results.map((item) => item.title), ['A1', 'B1', 'A2']);
    assert.equal(results.length, 3);
  });

  it('returns partial successes and records failed backend diagnostics', async () => {
    registerSearchEngine('mock-a', {
      create: () => ({
        async search() { return [source('ok', 'https://ok.test', { engine: 'mock-a' })]; },
      }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({
        async search() { throw new Error('community timeout apiKey=super-secret'); },
      }),
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'web', engine: 'mock-a' },
          { id: 'community', engine: 'mock-b' },
        ],
      },
    });

    const results = await engine.search('partial');
    assert.equal(results.length, 1);
    assert.equal(results[0].engine, 'mock-a');
    assert.equal(engine.lastDiagnostics.backends[1].status, 'failed');
    assert.match(engine.lastDiagnostics.backends[1].errorMessage, /\[redacted\]/);
    assert.equal(engine.lastDiagnostics.backends[1].errorMessage.includes('super-secret'), false);
  });

  it('throws an aggregate error when every backend fails', async () => {
    registerSearchEngine('mock-a', {
      create: () => ({ async search() { throw new Error('web down'); } }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({ async search() { throw new Error('community down'); } }),
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'web', engine: 'mock-a' },
          { id: 'community', engine: 'mock-b' },
        ],
      },
    });

    await assert.rejects(
      () => engine.search('all-fail'),
      (error) => {
        assert.equal(error.name, 'FanoutSearchError');
        assert.match(error.message, /web: web down/);
        assert.match(error.message, /community: community down/);
        assert.deepEqual(error.failures.map((item) => item.id), ['web', 'community']);
        return true;
      },
    );
    assert.ok(FanoutSearchError);
  });

  it('keeps successful results when another backend times out', async () => {
    registerSearchEngine('mock-a', {
      create: () => ({
        async search() {
          await delay(15);
          return [source('fast', 'https://fast.test', { engine: 'mock-a' })];
        },
      }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({
        async search() {
          await delay(25);
          throw new Error('backend timeout');
        },
      }),
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'fast', engine: 'mock-a' },
          { id: 'slow', engine: 'mock-b' },
        ],
      },
    });

    const results = await engine.search('timeout');
    assert.equal(results[0].title, 'fast');
    assert.equal(engine.lastDiagnostics.backends.find((item) => item.id === 'slow').status, 'failed');
  });

  it('propagates AbortError to in-flight backends and does not treat it as partial failure', async () => {
    const controller = new AbortController();
    const signals = [];
    registerSearchEngine('mock-a', {
      create: () => ({
        async search(_query, { signal } = {}) {
          signals.push(signal);
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          });
        },
      }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({
        async search(_query, { signal } = {}) {
          signals.push(signal);
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          });
        },
      }),
    });

    const engine = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'a', engine: 'mock-a' },
          { id: 'b', engine: 'mock-b' },
        ],
      },
    });

    const pending = engine.search('cancel-me', { signal: controller.signal });
    await delay(10);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(signals.length, 2);
    assert.equal(signals[0], controller.signal);
    assert.equal(signals[1], controller.signal);
  });

  it('counts logical queries and real backend calls separately and stops scheduling backends at the cap', async () => {
    const calls = { a: 0, b: 0 };
    registerSearchEngine('mock-a', {
      create: () => ({
        async search() {
          calls.a += 1;
          return [source('A', `https://a.test/${calls.a}`, { engine: 'mock-a' })];
        },
      }),
    });
    registerSearchEngine('mock-b', {
      create: () => ({
        async search() {
          calls.b += 1;
          return [source('B', `https://b.test/${calls.b}`, { engine: 'mock-b' })];
        },
      }),
    });

    const composite = createSearchEngine({
      search: {
        mode: 'fanout',
        backends: [
          { id: 'a', engine: 'mock-a' },
          { id: 'b', engine: 'mock-b' },
        ],
        fanout: { maxParallelBackends: 1 },
      },
    });
    const budget = new BudgetManager({
      research: { budget: { maxSearchRequests: 4, maxSearchBackendRequests: 3 } },
    });
    const events = [];
    const wrapped = wrapProvidersWithBudget({
      llm: { async complete() { return ''; } },
      search: composite,
      budget,
      onSearchEvent: (event) => events.push(event),
    });

    await wrapped.search.search('q1');
    await wrapped.search.search('q2');

    assert.equal(budget.usage.searchRequests, 2);
    assert.equal(budget.usage.searchBackendRequests, 3);
    assert.equal(calls.a + calls.b, 3);
    assert.ok(events.some((event) => event.status === 'skipped'));
    assert.ok(events.every((event) => !JSON.stringify(event).includes('apiKey')));
  });
});
