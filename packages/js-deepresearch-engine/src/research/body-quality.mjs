const WAF_OR_ERROR_NEEDLES = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /cloudflare/i,
  /enable javascript/i,
  /checking your browser/i,
  /please wait while we verify/i,
  /captcha/i,
  /forbidden/i,
];

export const MIN_FETCHED_BODY_CHARS = 80;
export const MIN_PROVIDED_BODY_CHARS = 12;

export function isWafShellText(text = '') {
  return WAF_OR_ERROR_NEEDLES.some((pattern) => pattern.test(String(text || '')));
}

export function isWafOrErrorBody(text = '', { fetchClaimedOk = false, minChars = MIN_FETCHED_BODY_CHARS } = {}) {
  const content = String(text || '');
  if (isWafShellText(content)) return true;
  if (!fetchClaimedOk) return false;
  const trimmed = content.trim();
  return trimmed.length > 0 && trimmed.length < minChars;
}

export function sourceBodyText(source = {}) {
  return String(source?.content || source?.summary || '').trim();
}

export function isSuccessfulBody(source = {}) {
  if (!source) return false;
  if (source.fetchStatus === 'failed' || source.fetchStatus === 'waf' || source.bodyQuality === 'waf') {
    return false;
  }
  const text = sourceBodyText(source);
  if (!text) return false;
  if (isWafShellText(text)) return false;
  if (source.contentOrigin === 'fetched' && text.length < MIN_FETCHED_BODY_CHARS) return false;
  if (text.length < MIN_PROVIDED_BODY_CHARS) return false;
  return source.fetchStatus !== 'failed';
}

export function classifyFetchedBody(source = {}) {
  const text = sourceBodyText(source);
  if (source.fetchStatus === 'failed') {
    return { status: 'failed', successful: false, reason: source.fetchError || 'fetch_failed' };
  }
  if (!text) {
    return { status: 'failed', successful: false, reason: 'empty_body' };
  }
  if (isWafShellText(text) || isWafOrErrorBody(text, { fetchClaimedOk: source.contentOrigin === 'fetched' })) {
    return { status: 'waf', successful: false, reason: 'waf_or_shell' };
  }
  if (source.contentOrigin === 'fetched' && text.length < MIN_FETCHED_BODY_CHARS) {
    return { status: 'waf', successful: false, reason: 'too_short_shell' };
  }
  if (!isSuccessfulBody({ ...source, content: text })) {
    return { status: 'failed', successful: false, reason: 'unusable_body' };
  }
  return { status: 'read', successful: true, reason: 'body_ok' };
}
