import { isWafShellText } from './body-quality.mjs';

const METADATA_PATHS = new Set(['jsonld', 'og', 'meta', 'rss']);
const BODY_PATHS = new Set(['next_data', 'amp', 'print', 'mobile', 'pdf', 'archive']);

export const ALTERNATE_EVIDENCE_ORDER = Object.freeze([
  'jsonld',
  'og',
  'next_data',
  'rss',
  'print',
  'amp',
  'pdf',
  'archive',
]);

function nowIso() {
  return new Date().toISOString();
}

function decodeEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = String(html || '').match(pattern);
      if (match?.[1]) return decodeEntities(match[1]);
    }
  }
  return undefined;
}

export function parseJsonLdBlocks(html = '') {
  const blocks = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed) blocks.push(parsed);
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return blocks;
}

function jsonLdNodes(block) {
  if (!block || typeof block !== 'object') return [];
  if (Array.isArray(block['@graph'])) return block['@graph'];
  return [block];
}

export function extractJsonLdMetadata(html = '') {
  const nodes = parseJsonLdBlocks(html).flatMap(jsonLdNodes);
  const preferred = nodes.find((node) => /Article|NewsArticle|Report|WebPage/i.test(String(node['@type'] || '')))
    || nodes[0];
  if (!preferred || typeof preferred !== 'object') return null;
  const title = preferred.headline || preferred.name || preferred.title;
  const publishedAt = preferred.datePublished || preferred.dateCreated;
  const description = preferred.description;
  if (!title && !publishedAt && !description) return null;
  return {
    retrievedVia: 'jsonld',
    evidenceRole: 'metadata',
    title: title ? decodeEntities(String(title)) : undefined,
    publishedAt: publishedAt ? String(publishedAt) : undefined,
    description: description ? decodeEntities(String(description)) : undefined,
    retrievedAt: nowIso(),
  };
}

export function extractOpenGraphMetadata(html = '') {
  const title = extractMetaContent(html, ['og:title', 'twitter:title']);
  const description = extractMetaContent(html, ['og:description', 'description', 'twitter:description']);
  const publishedAt = extractMetaContent(html, ['article:published_time', 'datePublished', 'date']);
  if (!title && !description && !publishedAt) return null;
  return {
    retrievedVia: 'og',
    evidenceRole: 'metadata',
    title,
    description,
    publishedAt,
    retrievedAt: nowIso(),
  };
}

export function extractNextDataRequest(html = '', pageUrl = '') {
  const match = String(html).match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const buildId = payload.buildId;
    const path = payload.page || new URL(pageUrl).pathname || '/';
    if (!buildId) {
      return {
        retrievedVia: 'next_data',
        evidenceRole: payload.props ? 'body' : 'metadata',
        title: payload.props?.pageProps?.title || payload.query?.title,
        content: payload.props ? JSON.stringify(payload.props) : undefined,
        retrievedAt: nowIso(),
      };
    }
    const jsonPath = path.endsWith('/') ? `${path}index` : path;
    return {
      retrievedVia: 'next_data',
      requestUrl: new URL(`/_next/data/${buildId}${jsonPath}.json`, pageUrl).toString(),
      payload,
    };
  } catch {
    return null;
  }
}

export function candidateFeedUrls(pageUrl = '') {
  const origin = new URL(pageUrl);
  return [
    new URL('/feed', origin).toString(),
    new URL('/rss.xml', origin).toString(),
    new URL('/atom.xml', origin).toString(),
    new URL('/feed.xml', origin).toString(),
    new URL('/sitemap.xml', origin).toString(),
  ];
}

export function parseFeedMetadata(xml = '', pageUrl = '') {
  const items = [...String(xml).matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map((match) => match[0]);
  const pageHost = (() => {
    try { return new URL(pageUrl).hostname; } catch { return ''; }
  })();
  const relevant = items.find((item) => {
    const link = item.match(/<(?:link|id)[^>]*>([^<]+)</i)?.[1]
      || item.match(/href=["']([^"']+)["']/i)?.[1]
      || '';
    return !pageUrl || link.includes(new URL(pageUrl).pathname) || (pageHost && link.includes(pageHost));
  }) || items[0];
  if (!relevant) return null;
  const title = decodeEntities(relevant.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const publishedAt = relevant.match(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\//i)?.[1]?.trim();
  const description = decodeEntities(
    relevant.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\//i)?.[1] || '',
  );
  if (!title && !publishedAt) return null;
  return {
    retrievedVia: 'rss',
    evidenceRole: 'metadata',
    title: title || undefined,
    publishedAt: publishedAt || undefined,
    description: description || undefined,
    retrievedAt: nowIso(),
  };
}

export function candidatePresentationUrls(pageUrl = '') {
  const parsed = new URL(pageUrl);
  const urls = [];
  parsed.searchParams.set('print', '1');
  urls.push({ retrievedVia: 'print', url: parsed.toString() });
  parsed.search = '';
  if (!parsed.pathname.includes('/amp')) {
    const ampPath = parsed.pathname.endsWith('/') ? `${parsed.pathname}amp/` : `${parsed.pathname}/amp`;
    parsed.pathname = ampPath;
    urls.push({ retrievedVia: 'amp', url: parsed.toString() });
  }
  if (!parsed.hostname.startsWith('m.')) {
    const mobile = new URL(pageUrl);
    mobile.hostname = `m.${mobile.hostname.replace(/^www\./, '')}`;
    urls.push({ retrievedVia: 'mobile', url: mobile.toString() });
  }
  return urls;
}

export function waybackCdxUrl(pageUrl = '') {
  const query = new URLSearchParams({
    url: pageUrl,
    output: 'json',
    limit: '1',
    filter: 'statuscode:200',
    fl: 'timestamp,original',
  });
  return `https://web.archive.org/cdx/search/cdx?${query}`;
}

export function waybackSnapshotUrl(timestamp, originalUrl) {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

export function parseWaybackCdx(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const data = rows.find((row) => Array.isArray(row) && row[0] && row[0] !== 'timestamp');
  if (!data) return null;
  const [timestamp, original] = data;
  return {
    retrievedVia: 'archive',
    snapshotTime: timestamp,
    snapshotUrl: waybackSnapshotUrl(timestamp, original),
    retrievedAt: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`,
  };
}

export function isMetadataOnlyPath(retrievedVia) {
  return METADATA_PATHS.has(String(retrievedVia || ''));
}

export function isBodyAlternatePath(retrievedVia) {
  return BODY_PATHS.has(String(retrievedVia || ''));
}

function htmlFromDirect(direct = {}) {
  return direct.previewHtml || (direct.status === 'ok' ? direct.content : '') || '';
}

function lockedToJsEyes(context = {}) {
  const backend = context.settings?.research?.read?.fetchBackend
    || context.settings?.research?.focused?.fetchBackend;
  return backend === 'js-eyes';
}

function shouldRecover(direct = {}, context = {}) {
  if (context.skipAlternateEvidence || lockedToJsEyes(context)) return false;
  if (!direct) return true;
  if (direct.transportMemorySkipped) return false;
  if (direct.status !== 'ok') return true;
  const content = String(direct.content || '').trim();
  if (!content) return true;
  return isWafShellText(content) || direct.bodyQuality === 'waf';
}

async function fetchAlternate(url, context) {
  const { fetchUrlContent } = await import('./content-fetcher.mjs');
  const { resolveContentFetchImpl } = await import('./content-resolver.mjs');
  return fetchUrlContent(url, {
    signal: context.signal,
    maxChars: context.maxChars,
    fetchImpl: resolveContentFetchImpl(context),
    maxAttempts: 1,
  });
}

export async function recoverAlternateEvidence(pageUrl, {
  direct = {},
  context = {},
} = {}) {
  if (!shouldRecover(direct, context)) return null;
  const html = htmlFromDirect(direct);
  const retrievedAt = nowIso();
  const metadata = (html ? extractJsonLdMetadata(html) : null)
    || (html ? extractOpenGraphMetadata(html) : null);

  const mergeMetadata = (body) => {
    if (!body) return body;
    return {
      ...body,
      title: body.title || metadata?.title,
      publishedAt: body.publishedAt || metadata?.publishedAt,
    };
  };

  const nextHint = html ? extractNextDataRequest(html, pageUrl) : null;
  if (nextHint?.content) {
    return mergeMetadata({ status: 'ok', ...nextHint, retrievedAt });
  }
  if (nextHint?.requestUrl) {
    const nextResult = await fetchAlternate(nextHint.requestUrl, context, 'next_data');
    if (nextResult?.status === 'ok' && nextResult.content) {
      return mergeMetadata({
        ...nextResult,
        retrievedVia: 'next_data',
        evidenceRole: 'body',
        retrievalPath: 'next_data',
        retrievedAt,
      });
    }
  }

  let feedMetadata = null;
  for (const feedUrl of candidateFeedUrls(pageUrl)) {
    const feed = await fetchAlternate(feedUrl, context, 'rss');
    if (feed?.status !== 'ok') continue;
    const parsed = parseFeedMetadata(feed.content, pageUrl);
    if (parsed) {
      feedMetadata = parsed;
      break;
    }
  }

  for (const candidate of candidatePresentationUrls(pageUrl)) {
    const result = await fetchAlternate(candidate.url, context, candidate.retrievedVia);
    if (result?.status === 'ok' && String(result.content || '').trim().length >= 80) {
      return mergeMetadata({
        ...result,
        retrievedVia: candidate.retrievedVia,
        evidenceRole: 'body',
        retrievalPath: candidate.retrievedVia,
        retrievedAt,
      });
    }
  }

  if (/\.pdf(?:$|[?#])/i.test(pageUrl) || /application\/pdf/i.test(direct.contentType || '')) {
    const pdf = await fetchAlternate(pageUrl, context, 'pdf');
    if (pdf?.status === 'ok') {
      return {
        ...pdf,
        retrievedVia: 'pdf',
        evidenceRole: 'body',
        retrievalPath: 'pdf',
        retrievedAt,
      };
    }
  }

  const cdx = await fetchAlternate(waybackCdxUrl(pageUrl), {
    ...context,
    skipResolver: true,
  }, 'archive');
  if (cdx?.status === 'ok') {
    let payload = cdx.content;
    try { payload = JSON.parse(cdx.content); } catch { /* already text */ }
    const snapshot = parseWaybackCdx(payload);
    if (snapshot?.snapshotUrl) {
      const archived = await fetchAlternate(snapshot.snapshotUrl, context, 'archive');
      if (archived?.status === 'ok' && archived.content) {
        return mergeMetadata({
          ...archived,
          retrievedVia: 'archive',
          evidenceRole: 'body',
          retrievalPath: 'archive',
          evidenceTier: 'reprint',
          retrievedAt: snapshot.retrievedAt,
          snapshotUrl: snapshot.snapshotUrl,
          snapshotTime: snapshot.snapshotTime,
        });
      }
    }
  }

  const fallback = metadata || feedMetadata;
  return fallback
    ? { ...fallback, status: 'ok', retrievedAt: fallback.retrievedAt || retrievedAt }
    : null;
}

export function archiveDisclosureText(source = {}) {
  if (source.retrievedVia !== 'archive') return null;
  const when = source.retrievedAt || source.snapshotTime || 'unknown time';
  const where = source.snapshotUrl || source.finalUrl || source.url;
  return `Evidence for ${source.url || 'this source'} was taken from an archive snapshot (${when}): ${where}. It is not a live first-party fetch.`;
}
