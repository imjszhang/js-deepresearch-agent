const MULTI_PART_SUFFIXES = new Set([
  'com.hk', 'com.cn', 'com.tw', 'com.sg', 'com.au', 'co.uk', 'co.jp', 'co.kr',
  'co.in', 'com.br', 'com.mx', 'co.nz', 'com.tr',
  'gov.hk', 'edu.hk', 'org.hk', 'net.hk',
  'gov.uk', 'ac.uk', 'gov.cn', 'edu.cn',
]);

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

export function registrableDomain(hostname) {
  const host = normalizeHost(hostname);
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function hostMatches(hostname, pattern) {
  const host = normalizeHost(hostname);
  const needle = normalizeHost(pattern);
  if (!host || !needle) return false;
  return host === needle || host.endsWith(`.${needle}`);
}

export function hostMatchesAny(hostname, patterns = []) {
  return (patterns || []).some((pattern) => hostMatches(hostname, pattern));
}

export function extractHostnamesFromText(value) {
  const text = String(value || '');
  const found = new Set();
  for (const match of text.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    found.add(normalizeHost(match[1]));
  }
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    found.add(normalizeHost(match[1]));
  }
  for (const match of text.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/gi)) {
    const host = normalizeHost(match[1]);
    if (host.split('.').length >= 2) found.add(host);
  }
  return [...found];
}

export function compactSearchQuestion(question, maxWords = 8) {
  return String(question || '')
    .replace(/\bsite:\S+/gi, '')
    .replace(/[^\p{L}\p{N}.-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

export function siteQueryForHost(host, question) {
  const focus = compactSearchQuestion(question);
  return focus ? `site:${normalizeHost(host)} ${focus}` : `site:${normalizeHost(host)}`;
}
