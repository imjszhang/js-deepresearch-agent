const MIN_SUCCESSFUL_BODY_CHARS = 12;

// Shared WAF / interstitial / empty-shell needles. Keep this list in the engine
// so benchmark scripts can reuse it without the engine importing benchmark code.
const WAF_OR_ERROR_NEEDLES = [
  /just a moment/i,
  /attention required/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /please enable javascript/i,
  /cloudflare/i,
  /cf-browser-verification/i,
  /cf-challenge/i,
  /challenge-platform/i,
  /cdn-cgi\/challenge/i,
  /access denied/i,
  /permission denied/i,
  /403 forbidden/i,
  /401 unauthorized/i,
  /sorry, you have been blocked/i,
  /you have been blocked/i,
  /request blocked/i,
  /please verify you are (a )?human/i,
  /verify you are human/i,
  /captcha/i,
  /hcaptcha/i,
  /recaptcha/i,
  /error 1020/i,
  /error 1015/i,
  /error 1006/i,
  /ray id\s*[:=]/i,
  /why have i been blocked/i,
  /this website is using a security service/i,
  /blocked by (?:the )?waf/i,
  /web application firewall/i,
  /akamai\s+ghost/i,
  /incident id/i,
  /request unsuccessful/i,
  /the requested url was rejected/i,
  /bot detection/i,
  /unusual traffic/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /gateway timeout/i,
  /bad gateway/i,
  /origin is unreachable/i,
  /please stand by/i,
  /performing security verification/i,
];

const FAILED_FETCH_STATUSES = new Set(['failed', 'waf', 'skipped', 'error', 'blocked']);

export function isWafOrErrorBody(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return WAF_OR_ERROR_NEEDLES.some((pattern) => pattern.test(text));
}

export function bodyTextOf(source = {}) {
  return String(source.content || source.summary || '').trim();
}

export function isSuccessfulBody(source = {}) {
  if (!source) return false;
  const status = String(source.fetchStatus || '').trim().toLowerCase();
  if (FAILED_FETCH_STATUSES.has(status)) return false;
  const text = bodyTextOf(source);
  if (!text || text.length < MIN_SUCCESSFUL_BODY_CHARS) return false;
  if (isWafOrErrorBody(text)) return false;
  if (isWafOrErrorBody(source.title) && text.length < 80) return false;
  return true;
}

export function annotateBodyQuality(source = {}) {
  const text = bodyTextOf(source);
  if (isWafOrErrorBody(text) || (source.fetchStatus === 'ok' && isWafOrErrorBody(source.title))) {
    return {
      ...source,
      fetchStatus: 'waf',
      fetchError: source.fetchError || 'WAF or error page',
      bodyQuality: 'waf',
    };
  }
  if (source.fetchStatus === 'failed' || source.fetchStatus === 'skipped') {
    return { ...source, bodyQuality: source.fetchStatus };
  }
  if (!text || text.length < MIN_SUCCESSFUL_BODY_CHARS) {
    if (source.fetchStatus === 'ok' || text) {
      return {
        ...source,
        fetchStatus: source.fetchStatus === 'ok' ? 'failed' : (source.fetchStatus || 'failed'),
        fetchError: source.fetchError || 'Empty or too-short body',
        bodyQuality: 'too_short',
      };
    }
    return { ...source, bodyQuality: 'missing' };
  }
  return { ...source, fetchStatus: source.fetchStatus || 'ok', bodyQuality: 'ok' };
}

export { MIN_SUCCESSFUL_BODY_CHARS, WAF_OR_ERROR_NEEDLES };
