import { inferPlatform } from './skill-registry.mjs';

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function engineLabel(platform, skillId) {
  if (platform === 'zhihu') return 'js-eyes:zhihu';
  if (platform === 'xhs') return 'js-eyes:xhs';
  if (platform === 'x') return 'js-eyes:x';
  if (platform === 'reddit') return 'js-eyes:reddit';
  return `js-eyes:${platform || skillId || 'unknown'}`;
}

function isUnifiedItem(item) {
  return item
    && typeof item === 'object'
    && (item.title || item.url)
    && (item.snippet !== undefined || item.platform !== undefined || item.engine !== undefined);
}

function normalizeRawItem(item, skillId) {
  const platform = inferPlatform(skillId);
  const author = typeof item.author === 'string'
    ? item.author
    : [item.author?.name, item.author?.username].filter(Boolean).join(' ');
  const body = firstString(
    item.excerpt,
    item.snippet,
    item.desc,
    item.description,
    item.content,
    item.selftext,
  );
  const extras = [
    author ? `Author: ${author}` : '',
    item.subredditPrefixed ? `Subreddit: ${item.subredditPrefixed}` : '',
    item.score != null ? `Score: ${item.score}` : '',
  ].filter(Boolean);

  return {
    title: firstString(item.title, item.name, item.url, 'Untitled source'),
    url: firstString(item.url, item.link, item.href, item.permalink, item.tweetUrl),
    snippet: [body, ...extras].filter(Boolean).join('\n'),
    platform,
    engine: engineLabel(platform, skillId),
  };
}

export function extractUnifiedItems(payload, skillId) {
  if (Array.isArray(payload?.items) && payload.items.length > 0) {
    return payload.items.map((item) => (isUnifiedItem(item)
      ? {
          ...item,
          platform: item.platform || inferPlatform(skillId),
          engine: item.engine || engineLabel(item.platform || inferPlatform(skillId), skillId),
        }
      : normalizeRawItem(item, skillId)));
  }

  const candidates = [
    payload?.result?.items,
    payload?.result?.tweets,
    payload?.result?.notes,
    payload?.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map((item) => normalizeRawItem(item, skillId));
    }
  }

  return [];
}

export function normalizeUnifiedItems(payload, config = {}, skillId) {
  const items = skillId
    ? extractUnifiedItems(payload, skillId)
    : (Array.isArray(payload?.items) ? payload.items : []).map((item) => ({
        title: firstString(item.title, item.url, 'Untitled source'),
        url: firstString(item.url, item.link, item.href),
        snippet: firstString(item.snippet, item.excerpt, item.desc, item.description, item.content),
        engine: firstString(item.engine, item.platform ? `js-eyes:${item.platform}` : 'js-eyes'),
      }));

  const maxResults = Number(config.maxResults) > 0 ? Math.floor(Number(config.maxResults)) : 8;

  return items
    .map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || '',
      engine: item.engine || 'js-eyes',
    }))
    .filter((item) => item.url || item.snippet)
    .slice(0, maxResults);
}

export function normalizeItemsToSources(items, maxResults) {
  return items
    .map((item) => ({
      title: firstString(item.title, item.url, 'Untitled source'),
      url: firstString(item.url, item.link, item.href),
      snippet: firstString(item.snippet, item.excerpt, item.desc, item.description, item.content),
      engine: firstString(item.engine, item.platform ? `js-eyes:${item.platform}` : 'js-eyes'),
    }))
    .filter((item) => item.url || item.snippet)
    .slice(0, maxResults);
}
