import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildCacheKey,
  contentSha256,
  lookupContentCache,
  normalizeCacheUrl,
  storeContentCache,
} from '../src/research/content-cache.mjs';
import {
  resetContentFetchHandlers,
  resolveUrlContent,
} from '../src/research/content-resolver.mjs';
import { classifySourceTier, isRequiredHostSource } from '../src/research/adaptive/source-policy.mjs';
import {
  collectManualImportHints,
  parseSourceUrlFrontMatter,
} from '../src/research/manual-import.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name === 'content-type' ? 'text/html' : null;
      },
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
  };
}

function cacheSettings(dir, extras = {}) {
  return {
    research: {
      focused: { fetchBackend: 'http' },
      read: {
        alternateEvidence: { enabled: false },
        cache: {
          enabled: extras.enabled !== false,
          dir,
          ttlMs: { html: extras.ttlMs || 60_000, default: extras.ttlMs || 60_000 },
          negativeTtlMs: extras.negativeTtlMs || 60_000,
          forceRefreshRequiredHosts: extras.forceRefreshRequiredHosts !== false,
        },
        transport: {
          maxAttempts: 1,
          hostCircuitThreshold: 3,
          responseHeadersTimeoutMs: 100,
          htmlTotalTimeoutMs: 100,
          documentTotalTimeoutMs: 200,
        },
      },
    },
    search: extras.search || {},
  };
}

afterEach(() => resetContentFetchHandlers());

describe('content cache', () => {
  it('normalizes URLs and hashes content', () => {
    assert.equal(
      normalizeCacheUrl('https://Example.com/path#frag'),
      'https://example.com/path',
    );
    assert.equal(contentSha256('hello').length, 64);
    assert.equal(
      buildCacheKey('https://example.com/a', { backends: ['http'], maxChars: 8000 }),
      buildCacheKey('https://example.com/a#x', { backends: ['http'], maxChars: 8000 }),
    );
  });

  it('serves a second resolve from disk without a new network call', async () => {
    const dir = tempDir('jdr-cache-');
    let fetches = 0;
    const settings = cacheSettings(dir);
    const context = {
      settings,
      fetchImpl: async () => {
        fetches += 1;
        return response(200, '<html><body>Official filing body with enough characters for a cacheable read.</body></html>');
      },
    };
    const first = await resolveUrlContent('https://example.com/filing', context);
    const second = await resolveUrlContent('https://example.com/filing', context);
    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    assert.equal(second.cacheHit, true);
    assert.equal(fetches, 1);
    assert.equal(second.content.includes('Official filing body'), true);
  });

  it('negatively caches 403 responses inside the short TTL', async () => {
    const dir = tempDir('jdr-neg-');
    let fetches = 0;
    const settings = cacheSettings(dir);
    const context = {
      settings,
      fetchImpl: async () => {
        fetches += 1;
        return response(403, '<html><body>denied</body></html>');
      },
    };
    const first = await resolveUrlContent('https://blocked.example/page', context);
    const afterFirst = fetches;
    const second = await resolveUrlContent('https://blocked.example/page', context);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.equal(second.cacheHit, true);
    assert.ok(afterFirst >= 1);
    assert.equal(fetches, afterFirst);
  });

  it('bypasses lookup and writes when cache is disabled', async () => {
    const dir = tempDir('jdr-nocache-');
    storeContentCache('https://example.com/a', {
      status: 'ok',
      content: 'stale',
      retrievedVia: 'direct',
    }, cacheSettings(dir), { backends: ['http'], fetchMode: 'summary', maxChars: 64000 });
    let fetches = 0;
    const settings = cacheSettings(dir, { enabled: false });
    const result = await resolveUrlContent('https://example.com/a', {
      settings,
      fetchImpl: async () => {
        fetches += 1;
        return response(200, '<html><body>Fresh network body with enough characters after --no-cache.</body></html>');
      },
    });
    assert.equal(result.cacheHit, undefined);
    assert.equal(fetches, 1);
    assert.match(result.content, /Fresh network body/);
    assert.equal(lookupContentCache('https://example.com/a', settings, {
      backends: ['http'],
      fetchMode: 'summary',
      maxChars: 64000,
    }), null);
  });

  it('does not use a positive cache hit for required hosts when force refresh is on', () => {
    const dir = tempDir('jdr-refresh-');
    const settings = cacheSettings(dir);
    storeContentCache('https://openai.com/policy', {
      status: 'ok',
      content: 'old policy',
      retrievedVia: 'direct',
    }, settings, { backends: ['http'], fetchMode: 'summary', maxChars: 64000 });
    const hit = lookupContentCache('https://openai.com/policy', settings, {
      backends: ['http'],
      fetchMode: 'summary',
      maxChars: 64000,
      requiredHosts: ['openai.com'],
    });
    assert.equal(hit, null);
  });
});

describe('manual import escape hatch', () => {
  it('parses sourceUrl front-matter', () => {
    const parsed = parseSourceUrlFrontMatter('---\nsourceUrl: https://openai.com/policy\n---\n# Policy\nBody');
    assert.equal(parsed.sourceUrl, 'https://openai.com/policy');
    assert.match(parsed.body, /# Policy/);
  });

  it('treats a file:// source with sourceUrl as the required host', () => {
    const source = {
      url: 'file:///tmp/notes/policy.md',
      sourceUrl: 'https://openai.com/policy',
      retrievedVia: 'manual_import',
    };
    assert.equal(isRequiredHostSource(source, { requiredHosts: ['openai.com'] }), true);
    assert.equal(classifySourceTier(source, { requiredHosts: ['openai.com'] }), 'required_primary');
  });

  it('returns a required host from a corpus sidecar without fetching', async () => {
    const corpus = tempDir('jdr-corpus-');
    const cacheDir = tempDir('jdr-cache-man-');
    fs.writeFileSync(path.join(corpus, 'policy.md'), [
      '---',
      'sourceUrl: https://openai.com/policy',
      '---',
      '',
      'Official policy body imported by hand with enough characters.',
      '',
    ].join('\n'));
    let fetches = 0;
    const result = await resolveUrlContent('https://openai.com/policy', {
      settings: cacheSettings(cacheDir, {
        search: { local: { dirs: [corpus] } },
      }),
      fetchImpl: async () => {
        fetches += 1;
        return response(403, 'denied');
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.retrievedVia, 'manual_import');
    assert.equal(result.sourceUrl, 'https://openai.com/policy');
    assert.equal(fetches, 0);
  });

  it('lists required hosts that still need a manual import', () => {
    const hints = collectManualImportHints({
      gaps: [{ id: 'slot-1', requiredHosts: ['openai.com'] }],
      readiness: {
        failures: [{
          code: 'required_host_missing',
          hostDiagnostics: [{ host: 'openai.com', reason: 'fetch_blocked' }],
        }],
      },
      corpusDirs: ['/tmp/notes'],
    });
    assert.equal(hints.length, 1);
    assert.match(hints[0], /openai.com/);
    assert.match(hints[0], /sourceUrl/);
  });

  it('does not hint when the host was read or only the body was rejected', () => {
    const rejected = collectManualImportHints({
      gaps: [{ id: 'slot-1', requiredHosts: ['openai.com'] }],
      readiness: {
        failures: [{
          code: 'required_host_missing',
          hostDiagnostics: [{ host: 'openai.com', reason: 'body_rejected' }],
        }],
      },
      corpusDirs: ['/tmp/notes'],
    });
    const fetched = collectManualImportHints({
      gaps: [{ id: 'slot-1', requiredHosts: ['openai.com'] }],
      readiness: {
        failures: [{
          code: 'required_host_missing',
          hostDiagnostics: [{ host: 'openai.com', reason: 'fetch_blocked' }],
        }],
      },
      findings: [{
        sources: [{ url: 'https://openai.com/policy', fetchStatus: 'ok' }],
      }],
      corpusDirs: ['/tmp/notes'],
    });
    const namedOnly = collectManualImportHints({
      gaps: [{ id: 'slot-1', requiredHosts: ['openai.com'] }],
      corpusDirs: ['/tmp/notes'],
    });
    assert.deepEqual(rejected, []);
    assert.deepEqual(fetched, []);
    assert.deepEqual(namedOnly, []);
  });
});
