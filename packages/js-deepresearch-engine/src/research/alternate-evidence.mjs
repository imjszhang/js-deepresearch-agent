import { isWafShellText } from './body-quality.mjs';

const METADATA_PATHS = new Set(['jsonld', 'og', 'meta', 'rss', 'sitemap']);
const BODY_PATHS = new Set([
  'next_data',
  'nuxt',
  'amp',
  'print',
  'mobile',
  'pdf',
  'docx',
  'archive',
  'google_cache',
]);
const REPRINT_PATHS = new Set(['archive', 'google_cache']);

export const ALTERNATE_EVIDENCE_ORDER = Object.freeze([
  'jsonld',
  'og',
  'next_data',
  'nuxt',
  'rss',
  'sitemap',
  'print',
  'amp',
  'pdf',
  'docx',
  'archive',
  'google_cache',
]);

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function extractStructuredArticleText(root) {
  const preferred = [];
  const fallback = [];
  const visit = (value, depth = 0, key = '') => {
    if (!value || depth > 6) return;
    if (typeof value === 'string') {
      const text = decodeEntities(value.replace(/<[^>]+>/g, ' ')).trim();
      const articleKey = /^(body|content|html|text|markdown)$/i.test(key);
      const min = articleKey ? 8 : 80;
      if (text.length >= min) (articleKey ? preferred : fallback).push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, key);
      return;
    }
    if (typeof value !== 'object') return;
    for (const childKey of ['body', 'content', 'html', 'text', 'article', 'markdown']) {
      if (value[childKey]) visit(value[childKey], depth + 1, childKey);
    }
    if (value.pageProps) visit(value.pageProps, depth + 1, 'pageProps');
    if (value.data) visit(value.data, depth + 1, 'data');
  };
  visit(root);
  const pick = (nodes) => nodes.sort((a, b) => b.length - a.length)[0];
  const content = pick(preferred) || pick(fallback);
  return content ? { content } : null;
}

export function extractNextDataRequest(html = '', pageUrl = '') {
  const match = String(html).match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const buildId = payload.buildId;
    const path = payload.page || new URL(pageUrl).pathname || '/';
    if (!buildId) {
      const article = extractStructuredArticleText(payload.props);
      return {
        retrievedVia: 'next_data',
        evidenceRole: article ? 'body' : 'metadata',
        title: payload.props?.pageProps?.title || payload.query?.title || article?.title,
        content: article?.content,
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

export function extractNuxtPayload(html = '', pageUrl = '') {
  const inline = String(html).match(/window\.__NUXT__\s*=\s*(\{[\s\S]*\})\s*;?\s*<\/script>/i)
    || String(html).match(/<script\b[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (inline) {
    try {
      const payload = JSON.parse(inline[1]);
      const article = extractStructuredArticleText(payload);
      if (article?.content) {
        return {
          retrievedVia: 'nuxt',
          evidenceRole: 'body',
          content: article.content,
          retrievedAt: nowIso(),
        };
      }
    } catch {
      // Fall through to payload URL.
    }
  }
  if (!/__NUXT__|_payload\.json|nuxt/i.test(html)) return null;
  try {
    const parsed = new URL(pageUrl);
    return {
      retrievedVia: 'nuxt',
      requestUrl: new URL(`${parsed.pathname.replace(/\/$/, '') || ''}/_payload.json`, parsed).toString(),
    };
  } catch {
    return null;
  }
}

export function parseSitemapLocs(xml = '') {
  return [...String(xml).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
    .map((match) => decodeEntities(match[1]))
    .filter(Boolean);
}

export function googleCacheUrl(pageUrl = '') {
  return `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(pageUrl)}`;
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

export function isReprintPath(retrievedVia) {
  return REPRINT_PATHS.has(String(retrievedVia || ''));
}

export function isLockedReprint(source = {}) {
  return source.evidenceTier === 'reprint'
    || isReprintPath(source.retrievedVia)
    || source.assessment?.evidenceTier === 'reprint';
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

function hostnameOf(value = '') {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sameHost(url, pageUrl) {
  const left = hostnameOf(url);
  const right = hostnameOf(pageUrl);
  return Boolean(left && right && left === right);
}

function isHostRefusal(direct = {}) {
  const status = Number(direct.httpStatus) || 0;
  return status === 403 || status === 429 || direct.challenge === true
    || ['challenge', 'http_403', 'http_429', 'http_4xx'].includes(String(direct.errorType || ''));
}

function usableBody(result = {}) {
  return result?.status === 'ok' && String(result.content || '').trim().length >= 80;
}

function canIssueAlternateHttp(context = {}, handlerCount = 0) {
  if (typeof context.fetchImpl === 'function') return true;
  if (handlerCount > 0) return true;
  const http = context.settings?.http;
  return Boolean(http && typeof http === 'object' && Object.keys(http).length > 0);
}

function shouldTryPublicReprint(direct = {}, context = {}, handlerCount = 0) {
  if (typeof context.fetchImpl === 'function') return true;
  if (handlerCount > 0) return false;
  return isHostRefusal(direct)
    || direct.bodyQuality === 'waf'
    || isWafShellText(direct.content || direct.previewHtml || '');
}

async function fetchAlternate(url, context, retrievalPath) {
  const {
    getContentFetchHandlers,
    resolveUrlContent,
    runRememberedAttempt,
  } = await import('./content-resolver.mjs');
  const injected = getContentFetchHandlers();
  if (typeof context.fetchImpl !== 'function' && injected.length > 0) {
    for (const handler of injected) {
      if (typeof handler.supports === 'function' && !handler.supports(url, context)) continue;
      const result = await runRememberedAttempt(url, context, {
        backend: 'http',
        retrievalPath,
        run: () => handler(url, context),
      });
      if (result?.status && result.status !== 'unsupported') return result;
    }
    return { status: 'unsupported', retrievalPath, backend: 'http' };
  }
  return resolveUrlContent(url, {
    ...context,
    retrievalPath,
    skipAlternateEvidence: true,
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

  const htmlPresent = Boolean(String(html || '').trim());
  const skipSameHostHttp = isHostRefusal(direct) || (direct.status !== 'ok' && !htmlPresent);
  const { getContentFetchHandlers } = await import('./content-resolver.mjs');
  const handlerCount = getContentFetchHandlers().length;
  const allowHttp = canIssueAlternateHttp(context, handlerCount);
  const nextHint = html ? extractNextDataRequest(html, pageUrl) : null;
  if (nextHint?.content) {
    return mergeMetadata({ status: 'ok', ...nextHint, retrievedAt });
  }
  if (allowHttp && nextHint?.requestUrl && (!skipSameHostHttp || !sameHost(nextHint.requestUrl, pageUrl))) {
    const nextResult = await fetchAlternate(nextHint.requestUrl, context, 'next_data');
    if (usableBody(nextResult)) {
      return mergeMetadata({
        ...nextResult,
        retrievedVia: 'next_data',
        evidenceRole: 'body',
        retrievalPath: 'next_data',
        retrievedAt,
      });
    }
  }

  const nuxtHint = html ? extractNuxtPayload(html, pageUrl) : null;
  if (nuxtHint?.content) {
    return mergeMetadata({ status: 'ok', ...nuxtHint, retrievedAt });
  }
  if (allowHttp && nuxtHint?.requestUrl && (!skipSameHostHttp || !sameHost(nuxtHint.requestUrl, pageUrl))) {
    const nuxtResult = await fetchAlternate(nuxtHint.requestUrl, context, 'nuxt');
    const article = extractStructuredArticleText(safeJson(nuxtResult?.content));
    if (usableBody({ ...nuxtResult, content: article?.content || nuxtResult?.content })) {
      return mergeMetadata({
        ...nuxtResult,
        retrievedVia: 'nuxt',
        evidenceRole: 'body',
        retrievalPath: 'nuxt',
        content: article?.content || nuxtResult.content,
        retrievedAt,
      });
    }
  }

  let feedMetadata = null;
  if (allowHttp && !skipSameHostHttp) {
    for (const feedUrl of candidateFeedUrls(pageUrl)) {
      const path = feedUrl.includes('sitemap') ? 'sitemap' : 'rss';
      const feed = await fetchAlternate(feedUrl, context, path);
      if (feed?.status !== 'ok') continue;
      if (path === 'sitemap') {
        const match = parseSitemapLocs(feed.content).find((loc) => loc === pageUrl || loc.includes(new URL(pageUrl).pathname));
        if (match && match !== pageUrl) {
          const discovered = await fetchAlternate(match, context, 'sitemap');
          if (usableBody(discovered)) {
            return mergeMetadata({
              ...discovered,
              retrievedVia: 'sitemap',
              evidenceRole: 'body',
              retrievalPath: 'sitemap',
              retrievedAt,
            });
          }
        }
        continue;
      }
      const parsed = parseFeedMetadata(feed.content, pageUrl);
      if (parsed) {
        feedMetadata = parsed;
        break;
      }
    }

    for (const candidate of candidatePresentationUrls(pageUrl)) {
      const result = await fetchAlternate(candidate.url, context, candidate.retrievedVia);
      if (usableBody(result)) {
        return mergeMetadata({
          ...result,
          retrievedVia: candidate.retrievedVia,
          evidenceRole: 'body',
          retrievalPath: candidate.retrievedVia,
          retrievedAt,
        });
      }
    }
  }

  if (allowHttp && !skipSameHostHttp && (/\.pdf(?:$|[?#])/i.test(pageUrl) || /application\/pdf/i.test(direct.contentType || ''))) {
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

  if (allowHttp && !skipSameHostHttp && (/\.docx(?:$|[?#])/i.test(pageUrl) || /officedocument\.wordprocessingml/i.test(direct.contentType || ''))) {
    const docx = await fetchAlternate(pageUrl, context, 'docx');
    if (docx?.status === 'ok') {
      return {
        ...docx,
        retrievedVia: 'docx',
        evidenceRole: 'body',
        retrievalPath: 'docx',
        retrievedAt,
      };
    }
  }

  const cdx = allowHttp && shouldTryPublicReprint(direct, context, handlerCount)
    ? await fetchAlternate(waybackCdxUrl(pageUrl), context, 'archive')
    : null;
  if (cdx?.status === 'ok') {
    const snapshot = parseWaybackCdx(safeJson(cdx.content) ?? cdx.content);
    if (snapshot?.snapshotUrl) {
      const archived = await fetchAlternate(snapshot.snapshotUrl, context, 'archive');
      if (usableBody(archived)) {
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

  const cached = allowHttp && shouldTryPublicReprint(direct, context, handlerCount)
    ? await fetchAlternate(googleCacheUrl(pageUrl), context, 'google_cache')
    : null;
  if (usableBody(cached)) {
    return mergeMetadata({
      ...cached,
      retrievedVia: 'google_cache',
      evidenceRole: 'body',
      retrievalPath: 'google_cache',
      evidenceTier: 'reprint',
      retrievedAt,
    });
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
