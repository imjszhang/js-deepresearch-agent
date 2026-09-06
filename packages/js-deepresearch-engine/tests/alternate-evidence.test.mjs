import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  archiveDisclosureText,
  candidateFeedUrls,
  candidatePresentationUrls,
  extractJsonLdMetadata,
  extractNextDataRequest,
  extractNuxtPayload,
  extractOpenGraphMetadata,
  googleCacheUrl,
  isLockedReprint,
  isMetadataOnlyPath,
  parseFeedMetadata,
  parseSitemapLocs,
  parseWaybackCdx,
  recoverAlternateEvidence,
  waybackSnapshotUrl,
} from '../src/research/alternate-evidence.mjs';
import { TransportMemory } from '../src/research/transport-memory.mjs';
import { classifySourceTier } from '../src/research/adaptive/source-policy.mjs';
import { renderEvidenceSection } from '../src/research/report-assembler.mjs';
import { sourceHasFetchedBody } from '../src/research/focused-settings.mjs';
import { enrichFindingSources } from '../src/research/source-enricher.mjs';
import { resolveUrlContent } from '../src/research/content-resolver.mjs';
import { Headers } from 'undici';

function deniedFetch(url) {
  return {
    ok: false,
    status: 403,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    arrayBuffer: async () => new TextEncoder().encode('<html><body>denied</body></html>'),
  };
}

const JSON_LD_PAGE = `<html><head>
<script type="application/ld+json">
{"@type":"NewsArticle","headline":"Official 2024 revenue","datePublished":"2024-03-31","description":"Filing summary"}
</script>
</head><body><nav>Home About</nav></body></html>`;

describe('alternate evidence parsers', () => {
  it('extracts JSON-LD title and date and marks the path metadata-only', () => {
    const parsed = extractJsonLdMetadata(JSON_LD_PAGE);
    assert.equal(parsed.retrievedVia, 'jsonld');
    assert.equal(parsed.evidenceRole, 'metadata');
    assert.equal(parsed.title, 'Official 2024 revenue');
    assert.equal(parsed.publishedAt, '2024-03-31');
    assert.equal(isMetadataOnlyPath('jsonld'), true);
    assert.equal(sourceHasFetchedBody({
      fetchStatus: 'failed',
      contentOrigin: 'metadata',
      evidenceRole: 'metadata',
      title: parsed.title,
      publishedAt: parsed.publishedAt,
    }), false);
  });

  it('extracts OpenGraph title and description', () => {
    const parsed = extractOpenGraphMetadata(`
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Description">
      <meta property="article:published_time" content="2025-01-02">
    `);
    assert.equal(parsed.retrievedVia, 'og');
    assert.equal(parsed.title, 'OG Title');
    assert.equal(parsed.publishedAt, '2025-01-02');
  });

  it('extracts embedded Next.js payload as a body path', () => {
    const parsed = extractNextDataRequest(`
      <script id="__NEXT_DATA__">{"page":"/filing","props":{"pageProps":{"title":"Next filing","body":"full text"}}}</script>
    `, 'https://example.com/filing');
    assert.equal(parsed.retrievedVia, 'next_data');
    assert.equal(parsed.evidenceRole, 'body');
    assert.match(parsed.content, /full text/);
  });

  it('does not stringify the entire Next props tree when buildId is missing', () => {
    const parsed = extractNextDataRequest(`
      <script id="__NEXT_DATA__">${JSON.stringify({
        props: {
          pageProps: {
            title: 'Filing',
            unused: { blob: 'x'.repeat(4000) },
            body: 'Official filing body recovered from embedded Next data.',
          },
        },
      })}</script>
    `, 'https://example.com/filing');
    assert.equal(parsed.retrievedVia, 'next_data');
    assert.equal(parsed.evidenceRole, 'body');
    assert.match(parsed.content, /Official filing body/);
    assert.ok(!parsed.content.includes('"unused"'));
    assert.ok(!parsed.content.includes('xxxx'));
  });

  it('extracts an inline Nuxt payload as a body path', () => {
    const parsed = extractNuxtPayload(`
      <script>window.__NUXT__ = {"data":[{"body":"Nuxt article body with enough official filing text for recovery."}]};</script>
    `, 'https://example.com/filing');
    assert.equal(parsed.retrievedVia, 'nuxt');
    assert.equal(parsed.evidenceRole, 'body');
    assert.match(parsed.content, /Nuxt article body/);
  });

  it('parses sitemap locs and builds a Google Cache URL', () => {
    assert.deepEqual(
      parseSitemapLocs('<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>'),
      ['https://example.com/a', 'https://example.com/b'],
    );
    assert.match(googleCacheUrl('https://example.com/filing'), /webcache\.googleusercontent\.com/);
  });

  it('parses RSS item metadata without treating it as a body', () => {
    const parsed = parseFeedMetadata(`
      <rss><channel>
        <item>
          <title>Feed headline</title>
          <link>https://example.com/filing</link>
          <pubDate>Mon, 31 Mar 2024 00:00:00 GMT</pubDate>
          <description>Short feed blurb</description>
        </item>
      </channel></rss>
    `, 'https://example.com/filing');
    assert.equal(parsed.retrievedVia, 'rss');
    assert.equal(parsed.evidenceRole, 'metadata');
    assert.equal(parsed.title, 'Feed headline');
    assert.match(parsed.publishedAt, /2024/);
  });

  it('builds print, AMP, feed, and Wayback snapshot URLs', () => {
    assert.ok(candidateFeedUrls('https://example.com/a/b').includes('https://example.com/rss.xml'));
    const presentations = candidatePresentationUrls('https://www.example.com/article');
    assert.ok(presentations.some((item) => item.retrievedVia === 'print' && item.url.includes('print=1')));
    assert.ok(presentations.some((item) => item.retrievedVia === 'amp' && item.url.includes('/amp')));
    const snapshot = parseWaybackCdx([
      ['timestamp', 'original'],
      ['20240102131415', 'https://example.com/a'],
    ]);
    assert.equal(snapshot.retrievedVia, 'archive');
    assert.equal(snapshot.snapshotUrl, waybackSnapshotUrl('20240102131415', 'https://example.com/a'));
  });
});

describe('alternate evidence recovery', () => {
  it('recovers title and date from a 403 page with JSON-LD without creating a fetched body', async () => {
    const result = await recoverAlternateEvidence('https://example.com/filing', {
      direct: {
        status: 'failed',
        httpStatus: 403,
        errorType: 'http_4xx',
        previewHtml: JSON_LD_PAGE,
      },
      context: { fetchImpl: deniedFetch, skipResolver: true },
    });
    assert.equal(result.retrievedVia, 'jsonld');
    assert.equal(result.evidenceRole, 'metadata');
    assert.equal(result.title, 'Official 2024 revenue');
    assert.equal(result.publishedAt, '2024-03-31');
    assert.equal(Boolean(result.content), false);
  });

  it('recovers an archive body with reprint tier and snapshot disclosure', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('web.archive.org/cdx')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify([
            ['timestamp', 'original'],
            ['20240102131415', 'https://example.com/blocked'],
          ])),
        };
      }
      if (String(url).includes('web.archive.org/web/')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><head><title>Archived filing</title></head><body>Official annual report revenue and controlling shareholder disclosure with enough archived text.</body></html>',
          ),
        };
      }
      return {
        ok: false,
        status: 403,
        url,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('<html><body>denied</body></html>'),
      };
    };

    const recovered = await recoverAlternateEvidence('https://example.com/blocked', {
      direct: { status: 'failed', httpStatus: 403, errorType: 'http_4xx' },
      context: { fetchImpl, skipResolver: true, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'archive');
    assert.equal(recovered.evidenceRole, 'body');
    assert.equal(recovered.evidenceTier, 'reprint');
    assert.match(recovered.content, /Official annual report/);
    assert.match(archiveDisclosureText({
      url: 'https://example.com/blocked',
      retrievedVia: 'archive',
      retrievedAt: recovered.retrievedAt,
      snapshotUrl: recovered.snapshotUrl,
    }), /archive snapshot/);
    const evidence = renderEvidenceSection([{
      question: 'What was disclosed?',
      sources: [{
        title: 'Archived filing',
        url: 'https://example.com/blocked',
        content: recovered.content,
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
        retrievedVia: 'archive',
        retrievedAt: recovered.retrievedAt,
        snapshotUrl: recovered.snapshotUrl,
        evidenceTier: 'reprint',
      }],
    }]);
    assert.match(evidence, /via archive/);
    assert.match(evidence, /archive snapshot/);
  });

  it('prefers a Wayback body over JSON-LD metadata when both exist', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('web.archive.org/cdx')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify([
            ['timestamp', 'original'],
            ['20240102131415', 'https://example.com/filing'],
          ])),
        };
      }
      if (String(url).includes('web.archive.org/web/')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><head><title>Archived filing</title></head><body>Official annual report revenue and controlling shareholder disclosure with enough archived text.</body></html>',
          ),
        };
      }
      return deniedFetch(url);
    };
    const recovered = await recoverAlternateEvidence('https://example.com/filing', {
      direct: {
        status: 'failed',
        httpStatus: 403,
        errorType: 'http_4xx',
        previewHtml: JSON_LD_PAGE,
      },
      context: { fetchImpl, skipResolver: true, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'archive');
    assert.equal(recovered.evidenceRole, 'body');
    assert.equal(recovered.evidenceTier, 'reprint');
    assert.equal(recovered.publishedAt, '2024-03-31');
    assert.match(recovered.title, /Archived filing|Official 2024 revenue/);
    assert.match(recovered.content, /Official annual report/);
  });

  it('enriches a 403 JSON-LD page as metadata without a direct-evidence body', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      url: 'https://example.com/filing',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => new TextEncoder().encode(JSON_LD_PAGE),
    });
    const fetched = await resolveUrlContent('https://example.com/filing', {
      fetchImpl,
      settings: { http: {}, research: { focused: { fetchBackend: 'http' }, read: { alternateEvidence: { enabled: true } } } },
    });
    const finding = await enrichFindingSources({
      question: 'What was disclosed?',
      sources: [{ url: 'https://example.com/filing', title: 'Search hit', snippet: 'nav' }],
    }, {
      fetchMode: 'summary',
      enrichConcurrency: 1,
      maxUrlsPerIteration: 4,
      maxUrlsTotal: 4,
      fetchImpl,
      settings: {
        http: {},
        research: {
          focused: { fetchMode: 'summary', fetchBackend: 'http' },
          read: { alternateEvidence: { enabled: true } },
        },
      },
    });
    const source = finding.sources[0];
    assert.equal(fetched.retrievedVia, 'jsonld');
    assert.equal(source.fetchStatus, 'failed');
    assert.equal(source.contentOrigin, 'metadata');
    assert.equal(source.title, 'Official 2024 revenue');
    assert.equal(source.publishedAt, '2024-03-31');
    assert.equal(sourceHasFetchedBody(source), false);
  });

  it('records alternate HTTP through transport memory and skips same-host fan-out after a 403', async () => {
    const memory = new TransportMemory({ hostCircuitThreshold: 3 });
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      if (String(url).includes('web.archive.org/cdx')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify([
            ['timestamp', 'original'],
            ['20240102131415', 'https://example.com/blocked'],
          ])),
        };
      }
      if (String(url).includes('web.archive.org/web/')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><head><title>Archived filing</title></head><body>Official annual report revenue and controlling shareholder disclosure with enough archived text.</body></html>',
          ),
        };
      }
      return deniedFetch(url);
    };

    const first = await resolveUrlContent('https://example.com/blocked', {
      fetchImpl,
      transportMemory: memory,
      settings: { http: {}, research: { focused: { fetchBackend: 'http' } } },
    });
    const second = await resolveUrlContent('https://example.com/blocked', {
      fetchImpl,
      transportMemory: memory,
      settings: { http: {}, research: { focused: { fetchBackend: 'http' } } },
    });

    assert.equal(first.retrievedVia, 'archive');
    assert.equal(first.evidenceTier, 'reprint');
    assert.equal(second.status, 'skipped');
    assert.ok(!seen.some((url) => url.includes('print=1') || url.includes('/amp') || url.endsWith('/rss.xml')));
    assert.equal(seen.filter((url) => url === 'https://example.com/blocked').length, 1);
  });

  it('recovers a Nuxt _payload.json body', async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/_payload.json')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({
            data: [{ body: 'Nuxt payload article body with enough official filing text for recovery of the annual report.' }],
          })),
        };
      }
      return deniedFetch(url);
    };
    const recovered = await recoverAlternateEvidence('https://example.com/filing', {
      direct: {
        status: 'ok',
        bodyQuality: 'waf',
        content: '<html><body>Just a moment</body></html>',
        previewHtml: '<html><script>window.__NUXT__ = 1</script></html>',
      },
      context: { fetchImpl, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'nuxt');
    assert.equal(recovered.evidenceRole, 'body');
    assert.match(recovered.content, /Nuxt payload article body/);
  });

  it('recovers a same-host body discovered via sitemap', async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/sitemap.xml')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/xml' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<urlset><url><loc>https://example.com/filing-full</loc></url></urlset>',
          ),
        };
      }
      if (String(url) === 'https://example.com/filing-full') {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><body>Sitemap discovered filing body with enough official text for recovery of the annual report.</body></html>',
          ),
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'application/xml' }),
        arrayBuffer: async () => new TextEncoder().encode('<rss></rss>'),
      };
    };
    const recovered = await recoverAlternateEvidence('https://example.com/filing', {
      direct: {
        status: 'failed',
        error: 'empty',
        errorType: 'empty_body',
        previewHtml: '<html></html>',
      },
      context: { fetchImpl, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'sitemap');
    assert.match(recovered.content, /Sitemap discovered filing body/);
  });

  it('recovers a Google Cache reprint when Wayback is empty', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('webcache.googleusercontent.com')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><body>Google Cache reprint of the official filing with enough recovered text for the annual report.</body></html>',
          ),
        };
      }
      return deniedFetch(url);
    };
    const recovered = await recoverAlternateEvidence('https://example.com/blocked', {
      direct: { status: 'failed', httpStatus: 403, errorType: 'http_4xx' },
      context: { fetchImpl, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'google_cache');
    assert.equal(recovered.evidenceTier, 'reprint');
    assert.match(recovered.content, /Google Cache reprint/);
  });

  it('recovers a DOCX body from the document converter path', async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('.docx')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new TextEncoder().encode(
            '<html><body>DOCX filing body recovered with enough official text for the alternate path.</body></html>',
          ),
        };
      }
      return deniedFetch(url);
    };
    const recovered = await recoverAlternateEvidence('https://example.com/filing.docx', {
      direct: {
        status: 'failed',
        error: 'converter_failed',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        previewHtml: '<html></html>',
      },
      context: { fetchImpl, maxChars: 4000 },
    });
    assert.equal(recovered.retrievedVia, 'docx');
    assert.match(recovered.content, /DOCX filing body/);
  });

  it('keeps archive reprint after enrich and source-policy classification', async () => {
    const source = {
      url: 'https://example.com/blocked',
      retrievedVia: 'archive',
      evidenceTier: 'reprint',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      assessment: { evidenceTier: 'other_primary' },
    };
    assert.equal(isLockedReprint(source), true);
    assert.equal(classifySourceTier(source, { requiredHosts: ['example.com'] }), 'reprint');
  });
});
