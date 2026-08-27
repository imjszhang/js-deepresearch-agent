const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'com.hk',
  'org.hk',
  'gov.hk',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
]);

const WAF_OR_ERROR_NEEDLES = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /cloudflare/i,
  /enable javascript/i,
];

export const MIN_FETCHED_BODY_CHARS = 80;

export function parseUrlParts(url) {
  try {
    const parsed = new URL(String(url || ''));
    return {
      hostname: String(parsed.hostname || '').toLowerCase().replace(/\.$/, ''),
      pathname: parsed.pathname || '/',
    };
  } catch {
    return null;
  }
}

export function stripLeadingWww(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function hostnamesMatch(urlHostname, policyHost) {
  const left = String(urlHostname || '').toLowerCase().replace(/\.$/, '');
  const right = String(policyHost || '').toLowerCase().replace(/\.$/, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return stripLeadingWww(left) === stripLeadingWww(right);
}

export function pathHasPrefix(pathname = '/', pathPrefix = '') {
  if (!pathPrefix) return true;
  const path = pathname || '/';
  const prefix = String(pathPrefix);
  if (path === prefix || path.startsWith(prefix)) return true;
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === trimmed || path.startsWith(`${trimmed}/`);
}

export function sourceMatchesPolicy(url, policyEntries = []) {
  const parts = parseUrlParts(url);
  if (!parts) return false;
  return (policyEntries || []).some((entry) => {
    if (!entry?.host) return false;
    return hostnamesMatch(parts.hostname, entry.host)
      && pathHasPrefix(parts.pathname, entry.pathPrefix);
  });
}

export function registrableDomain(hostname) {
  const stripped = stripLeadingWww(hostname);
  if (!stripped) return '';
  const labels = stripped.split('.').filter(Boolean);
  if (labels.length <= 2) return stripped;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export function registrableDomainFromUrl(url) {
  const parts = parseUrlParts(url);
  return parts ? registrableDomain(parts.hostname) : '';
}

export function isWafOrErrorBody(text = '', { fetchClaimedOk = false } = {}) {
  const content = String(text || '');
  if (WAF_OR_ERROR_NEEDLES.some((pattern) => pattern.test(content))) return true;
  return fetchClaimedOk && content.trim().length > 0 && content.trim().length < MIN_FETCHED_BODY_CHARS;
}
